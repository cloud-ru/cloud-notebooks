import * as fs from "node:fs";
import * as vscode from "vscode";
import type { NotebookHandlerResponse, WorkspaceContext } from "../api/types";
import type { ConsoleApiClient, SshGatewayConfig } from "../console/apiClient";
import type { Logger } from "../util/logger";
import type { SshConnectionConfig } from "./connection";
import {
  buildUsername,
  DEFAULT_SSH_HOST,
  DEFAULT_SSH_PORT,
  parseSshCommand,
  regionTypeFromNotebookUrl,
  type SshEndpoint,
} from "./sshUrl";

export interface SshConfigDeps {
  client: ConsoleApiClient;
  /** The active workspace — its namespace is the SSH account id. */
  getWorkspace: () => WorkspaceContext | undefined;
  logger: Logger;
}

const ENDPOINTS_KEY = "cloudru.ssh.endpoints";
const TARGETS_KEY = "cloudru.ssh.targets";

interface PersistedTarget {
  host: string;
  port: number;
  username: string;
}

/**
 * Resolves the SSH inputs that are not in the public API and turns them into a per-notebook target.
 * The private key is downloaded from the console once; the gateway endpoint is built from console
 * data with nothing to copy — account id = the active workspace namespace, host/port = the console
 * SSH-config endpoint — falling back to a pasted command only when that data is unavailable or wrong.
 * Shared by the file browser (SFTP) and the remote kernel (port forward).
 */
export class SshConfig {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: SshConfigDeps,
  ) {}

  /** Build the SSH target for a notebook, prompting for key/endpoint if needed. */
  async resolveTarget(notebook: NotebookHandlerResponse): Promise<SshConnectionConfig | undefined> {
    if (!notebook.url) return undefined;

    const privateKey = await this.ensurePrivateKey();
    if (!privateKey) return undefined;
    const endpoint = await this.ensureEndpoint(notebook);
    if (!endpoint) return undefined;

    const target: PersistedTarget = {
      host: endpoint.host,
      port: endpoint.port,
      username: buildUsername(notebook.name, endpoint.accountId),
    };
    await this.saveTarget(notebook.uid, target);
    this.deps.logger.info(
      `[ssh] final command for "${notebook.name}": ssh ${target.username}@${target.host} -p ${target.port} -i <key>`,
    );
    return { ...target, privateKey };
  }

  /**
   * Rebuild a target for a previously-mounted notebook without any prompts (used by the file system
   * provider to reconnect after an extension-host reload). Returns undefined if config is missing.
   */
  async resolveSilently(uid: string): Promise<SshConnectionConfig | undefined> {
    const target = this.loadTarget(uid);
    if (!target) return undefined;
    const privateKey = this.loadPrivateKey();
    if (!privateKey) return undefined;
    return { ...target, privateKey };
  }

  /** SSH details for an `~/.ssh/config` Host entry used by Remote-SSH (full IDE mode). */
  async resolveConfigEntry(
    notebook: NotebookHandlerResponse,
  ): Promise<{ host: string; port: number; username: string; identityFile: string } | undefined> {
    if (!notebook.url) return undefined;

    const identityFile = await this.ensureKeyPath();
    if (!identityFile) return undefined;
    const endpoint = await this.ensureEndpoint(notebook);
    if (!endpoint) return undefined;

    return {
      host: endpoint.host,
      port: endpoint.port,
      username: buildUsername(notebook.name, endpoint.accountId),
      identityFile,
    };
  }

  /** Path to the configured private key, prompting to pick one if not set. */
  private async ensureKeyPath(): Promise<string | undefined> {
    const configured = vscode.workspace.getConfiguration("cloudru").get<string>("ssh.privateKeyPath", "");
    const keyPath = configured || (await this.pickPrivateKey());
    if (keyPath) await this.tightenKeyPermissions(keyPath);
    return keyPath;
  }

  /**
   * OpenSSH (used by Remote-SSH for the full IDE) refuses a group/world-readable key file with
   * "bad permissions" → "Permission denied (publickey)". The SFTP/kernel path reads the key bytes via
   * ssh2 and never checks perms, so a freshly downloaded 0644 key works there but breaks the full IDE.
   * Tighten to 0600 best-effort (no-op on platforms without POSIX perms, e.g. Windows).
   */
  private async tightenKeyPermissions(keyPath: string): Promise<void> {
    try {
      await fs.promises.chmod(keyPath, 0o600);
    } catch (err) {
      this.deps.logger.warn(`[ssh] could not set 0600 on key ${keyPath}: ${(err as Error).message}`);
    }
  }

  private async saveTarget(uid: string, target: PersistedTarget): Promise<void> {
    const all = this.context.globalState.get<Record<string, PersistedTarget>>(TARGETS_KEY, {});
    all[uid] = target;
    await this.context.globalState.update(TARGETS_KEY, all);
  }

  private loadTarget(uid: string): PersistedTarget | undefined {
    return this.context.globalState.get<Record<string, PersistedTarget>>(TARGETS_KEY, {})[uid];
  }

  /** Re-pick the private key and forget cached endpoints/targets, so the next connection re-captures
   * the host/account from a fresh console SSH command (explicit "Configure SSH" command). */
  async configure(): Promise<void> {
    await this.pickPrivateKey();
    await this.context.globalState.update(ENDPOINTS_KEY, {});
    await this.context.globalState.update(TARGETS_KEY, {});
  }

  private async ensurePrivateKey(): Promise<Buffer | undefined> {
    const existing = this.loadPrivateKey();
    if (existing) return existing;
    const path = (await this.pickPrivateKey()) ?? "";
    if (!path) return undefined;
    return this.loadPrivateKey();
  }

  /** Read the configured private key from disk, without prompting. */
  private loadPrivateKey(): Buffer | undefined {
    const path = vscode.workspace.getConfiguration("cloudru").get<string>("ssh.privateKeyPath", "");
    if (!path) return undefined;
    try {
      return fs.readFileSync(path);
    } catch (err) {
      void vscode.window.showErrorMessage(`Cannot read SSH key at ${path}: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async pickPrivateKey(): Promise<string | undefined> {
    const picked = await vscode.window.showOpenDialog({
      title: "Select the ML Space SSH private key (downloaded from the console)",
      canSelectMany: false,
      openLabel: "Use this key",
    });
    const path = picked?.[0]?.fsPath;
    if (path) {
      await vscode.workspace
        .getConfiguration("cloudru")
        .update("ssh.privateKeyPath", path, vscode.ConfigurationTarget.Global);
    }
    return path;
  }

  /**
   * The gateway endpoint for a notebook. A manual override (saved per region by `captureEndpoint`)
   * wins; otherwise it is auto-derived from the running notebook (host + namespace, no console trip);
   * if that is not possible the user is prompted for the console command.
   */
  private async ensureEndpoint(notebook: NotebookHandlerResponse): Promise<SshEndpoint | undefined> {
    const region = notebook.region || "";
    const override = this.context.globalState.get<Record<string, SshEndpoint>>(ENDPOINTS_KEY, {})[region];
    if (override) {
      this.deps.logger.info(
        `[ssh] using saved endpoint override for region "${region}": ` +
          `ssh ${buildUsername(notebook.name, override.accountId)}@${override.host} -p ${override.port}`,
      );
      return override;
    }
    const derived = await this.deriveEndpoint(notebook);
    if (derived) return derived;
    this.deps.logger.warn(
      `[ssh] auto-derivation produced no endpoint for "${notebook.name}" — asking you to paste the SSH command`,
    );
    return this.captureEndpoint(notebook);
  }

  /**
   * Build the endpoint from console data, no command to copy: account id = the active workspace
   * namespace, host/port = the console SSH-config endpoint for the notebook's region type. Returns
   * undefined (so the caller falls back to a pasted command) when the workspace/namespace is unknown
   * or the config endpoint yields no host.
   */
  private async deriveEndpoint(notebook: NotebookHandlerResponse): Promise<SshEndpoint | undefined> {
    const ws = this.deps.getWorkspace();
    if (!ws) {
      this.deps.logger.warn("[ssh] cannot auto-derive: no active workspace selected (Cloud.ru: Select Workspace)");
      return undefined;
    }
    // The account id is the workspace namespace. A session stored before namespace capture won't have
    // it, so look it up from /user/v1/workspaces/ rather than forcing a manual re-select.
    const accountId = ws.namespace?.trim() || (await this.lookupNamespace(ws));
    if (!accountId) {
      this.deps.logger.warn(
        `[ssh] cannot auto-derive account id: workspace "${ws.workspaceName}" (id=${ws.workspaceId}) has no ` +
          "namespace in /user/v1/workspaces/. Will ask for the SSH command.",
      );
      return undefined;
    }

    const regionType = regionTypeFromNotebookUrl(notebook.url);
    this.deps.logger.info(
      `[ssh] auto-deriving endpoint for "${notebook.name}": account=${accountId}, region_type=${regionType} ` +
        `(notebook.region=${notebook.region}, url=${notebook.url})`,
    );
    let gateway: SshGatewayConfig | undefined;
    try {
      gateway = await this.deps.client.getSshGatewayConfig(ws, regionType, notebook.region);
    } catch (err) {
      this.deps.logger.error("[ssh] notebooks/config request failed; will ask for the SSH command", err);
      return undefined;
    }
    if (!gateway) {
      this.deps.logger.warn(
        `[ssh] no SSH gateway for region "${notebook.region}" in notebooks/config; will ask for the SSH command`,
      );
      return undefined;
    }

    const port =
      gateway.port ?? vscode.workspace.getConfiguration("cloudru").get<number>("ssh.port", DEFAULT_SSH_PORT);
    this.deps.logger.info(
      `[ssh] auto-derived: ssh ${buildUsername(notebook.name, accountId)}@${gateway.url} -p ${port}`,
    );
    return { host: gateway.url, port, accountId };
  }

  /** Fetch the active workspace's namespace from /user/v1/workspaces/ (used when the stored session
   * predates namespace capture). */
  private async lookupNamespace(ws: WorkspaceContext): Promise<string | undefined> {
    try {
      const all = await this.deps.client.listWorkspaces();
      const namespace = all.find((w) => w.workspace_id === ws.workspaceId)?.namespace?.trim();
      this.deps.logger.info(
        `[ssh] looked up namespace for workspace ${ws.workspaceId}: ${namespace ?? "—"} ` +
          `(workspaces returned: ${all.length})`,
      );
      return namespace;
    } catch (err) {
      this.deps.logger.error("[ssh] failed to look up workspace namespace", err);
      return undefined;
    }
  }

  /**
   * Prompt for the console SSH command and remember it for the notebook's region. Used as the
   * fallback when auto-derivation has no inputs, and as the recovery path when a derived endpoint
   * fails to connect (the saved override then takes precedence for the whole region).
   */
  async captureEndpoint(notebook: NotebookHandlerResponse): Promise<SshEndpoint | undefined> {
    const endpoint = await this.promptEndpoint();
    if (endpoint) await this.saveEndpoint(notebook.region || "", endpoint);
    return endpoint;
  }

  private async saveEndpoint(region: string, endpoint: SshEndpoint): Promise<void> {
    const all = this.context.globalState.get<Record<string, SshEndpoint>>(ENDPOINTS_KEY, {});
    all[region] = endpoint;
    await this.context.globalState.update(ENDPOINTS_KEY, all);
  }

  private async promptEndpoint(): Promise<SshEndpoint | undefined> {
    const input = (
      await vscode.window.showInputBox({
        title: "Cloud.ru SSH — paste the connection command (or account id)",
        prompt:
          "Open the notebook's SSH dialog in the console and paste the whole command here — the gateway " +
          "host, port and account id are read from it (the “-i <key>” part is ignored; the key file you " +
          "picked is used). You may also type just the account id to use the configured default host.",
        placeHolder:
          "ssh name.ai0001011-00055@ssh-jupyter.ai.cloud.ru -p 2222   ·   or just  ai0001011-00055",
        ignoreFocusOut: true,
      })
    )?.trim();
    if (!input) return undefined;

    if (input.includes("@")) {
      const parsed = parseSshCommand(input);
      if (!parsed) {
        void vscode.window.showErrorMessage(
          "Could not parse the SSH command. Paste the whole line from the console SSH dialog.",
        );
        return undefined;
      }
      return { host: parsed.host, port: parsed.port, accountId: parsed.accountId };
    }

    if (!/^[A-Za-z]+\d+-\d+$/.test(input)) {
      void vscode.window.showErrorMessage(
        "Could not read the account id. Paste the full SSH command, or just the id (e.g. ai0001011-00055).",
      );
      return undefined;
    }
    const config = vscode.workspace.getConfiguration("cloudru");
    return {
      host: config.get<string>("ssh.host", DEFAULT_SSH_HOST),
      port: config.get<number>("ssh.port", DEFAULT_SSH_PORT),
      accountId: input,
    };
  }
}
