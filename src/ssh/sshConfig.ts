import * as fs from "node:fs";
import * as path from "node:path";
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

  /** Build the SSH target for a notebook. With `interactive: false` (the kernel picker) it never opens
   * a dialog — it uses only already-configured key/endpoint and returns undefined otherwise (H11). */
  async resolveTarget(
    notebook: NotebookHandlerResponse,
    opts: { interactive?: boolean } = {},
  ): Promise<SshConnectionConfig | undefined> {
    if (!notebook.url) return undefined;
    const interactive = opts.interactive ?? true;

    const privateKey = interactive ? await this.ensurePrivateKey() : this.loadPrivateKey();
    if (!privateKey) return undefined;
    const endpoint = await this.ensureEndpoint(notebook, interactive);
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
    const endpoint = await this.ensureEndpoint(notebook, true);
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
    const keyPath = configured || (await this.obtainKeyPath());
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
    const keyPath = await this.obtainKeyPath();
    if (!keyPath) return undefined;
    return this.loadPrivateKey();
  }

  /** Read the configured private key from disk, without prompting. */
  private loadPrivateKey(): Buffer | undefined {
    const path = vscode.workspace.getConfiguration("cloudru").get<string>("ssh.privateKeyPath", "");
    if (!path) return undefined;
    try {
      return fs.readFileSync(path);
    } catch (err) {
      void vscode.window.showErrorMessage(`Не удалось прочитать SSH-ключ по пути ${path}: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async pickPrivateKey(): Promise<string | undefined> {
    const picked = await vscode.window.showOpenDialog({
      title: "Выберите приватный SSH-ключ ML Space (скачан из консоли)",
      canSelectMany: false,
      openLabel: "Использовать ключ",
    });
    const path = picked?.[0]?.fsPath;
    if (path) {
      await vscode.workspace
        .getConfiguration("cloudru")
        .update("ssh.privateKeyPath", path, vscode.ConfigurationTarget.Global);
    }
    return path;
  }

  /** When no key is configured, ask how to provide one — generate via the API or pick a file — rather
   * than dropping the user straight into a file dialog (3.3). Returns the resolved key path. */
  private async obtainKeyPath(): Promise<string | undefined> {
    const GENERATE = "Сгенерировать новый ключ (старый перестанет работать)";
    const PICK = "Выбрать файл ключа…";
    const choice = await vscode.window.showQuickPick([GENERATE, PICK], {
      title: "SSH-ключ ML Space не настроен",
      placeHolder: "Как получить ключ для доступа к ноутбукам по SSH?",
      ignoreFocusOut: true,
    });
    if (choice === GENERATE) return this.generateKey();
    if (choice === PICK) return this.pickPrivateKey();
    return undefined;
  }

  /** Generate a fresh SSH key via the console API, store it 0600 under globalStorage, point the config
   * at it, and offer to save a copy. Returns the stored path (undefined on failure). */
  async generateKey(): Promise<string | undefined> {
    const ws = this.deps.getWorkspace();
    if (!ws) {
      void vscode.window.showWarningMessage("Сначала выберите воркспейс Cloud.ru.");
      return undefined;
    }
    const pair = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Генерация SSH-ключа…" },
      () => this.deps.client.generateSshKey(ws),
    );
    if (!pair.private_key) {
      void vscode.window.showErrorMessage("Сервер не вернул приватный ключ.");
      return undefined;
    }
    const dest = vscode.Uri.joinPath(this.context.globalStorageUri, "ssh", "mlspace.private_key").fsPath;
    try {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, withTrailingNewline(pair.private_key), { mode: 0o600 });
      await fs.promises.chmod(dest, 0o600);
    } catch (err) {
      this.deps.logger.error("[ssh] failed to store generated key", err);
      void vscode.window.showErrorMessage(`Не удалось сохранить SSH-ключ: ${(err as Error).message}`);
      return undefined;
    }
    await vscode.workspace
      .getConfiguration("cloudru")
      .update("ssh.privateKeyPath", dest, vscode.ConfigurationTarget.Global);
    this.deps.logger.info(`[ssh] generated new SSH key → ${dest}`);
    await this.offerSaveCopy(pair.private_key);
    return dest;
  }

  private async offerSaveCopy(privateKey: string): Promise<void> {
    const SAVE = "Сохранить копию…";
    const choice = await vscode.window.showInformationMessage(
      "Новый SSH-ключ сгенерирован и настроен для расширения.",
      SAVE,
    );
    if (choice !== SAVE) return;
    const uri = await vscode.window.showSaveDialog({
      saveLabel: "Сохранить ключ",
      defaultUri: vscode.Uri.file("mlspace_ssh_key"),
    });
    if (!uri) return;
    try {
      await fs.promises.writeFile(uri.fsPath, withTrailingNewline(privateKey), { mode: 0o600 });
    } catch (err) {
      void vscode.window.showErrorMessage(`Не удалось сохранить копию ключа: ${(err as Error).message}`);
    }
  }

  /**
   * The gateway endpoint for a notebook. A manual override (saved per region by `captureEndpoint`)
   * wins; otherwise it is auto-derived from the running notebook (host + namespace, no console trip);
   * if that is not possible the user is prompted for the console command.
   */
  private async ensureEndpoint(
    notebook: NotebookHandlerResponse,
    interactive: boolean,
  ): Promise<SshEndpoint | undefined> {
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
    if (!interactive) {
      this.deps.logger.warn(`[ssh] no endpoint for "${notebook.name}" (non-interactive) — refusing to open a dialog`);
      return undefined;
    }
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
        title: "Cloud.ru SSH — вставьте команду подключения (или id аккаунта)",
        prompt:
          "Откройте диалог SSH ноутбука в консоли и вставьте команду целиком — из неё берутся хост, порт " +
          "и id аккаунта («-i <key>» игнорируется, используется выбранный вами файл ключа). Можно ввести " +
          "только id аккаунта, чтобы использовать хост по умолчанию.",
        placeHolder:
          "ssh name.ai0000000-00000@ssh-jupyter.ai.cloud.ru -p 2222   ·   или просто  ai0000000-00000",
        ignoreFocusOut: true,
      })
    )?.trim();
    if (!input) return undefined;

    if (input.includes("@")) {
      const parsed = parseSshCommand(input);
      if (!parsed) {
        void vscode.window.showErrorMessage(
          "Не удалось разобрать SSH-команду. Вставьте всю строку из диалога SSH в консоли.",
        );
        return undefined;
      }
      return { host: parsed.host, port: parsed.port, accountId: parsed.accountId };
    }

    if (!/^[A-Za-z]+\d+-\d+$/.test(input)) {
      void vscode.window.showErrorMessage(
        "Не удалось прочитать id аккаунта. Вставьте полную SSH-команду или только id (например, ai0000000-00000).",
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

function withTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
