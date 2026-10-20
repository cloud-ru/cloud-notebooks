import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { utils as sshUtils } from "ssh2";
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
  getGeneration: () => number;
  isSignedIn: () => Promise<boolean>;
  logger: Logger;
}

const ENDPOINTS_KEY = "cloudru.ssh.endpoints";
const TARGETS_KEY = "cloudru.ssh.targets";
const HOST_KEYS_KEY = "cloudru.ssh.hostKeys";

interface PersistedTarget {
  workspaceId: string;
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
  private readonly hostKeyChecks = new Map<string, Promise<boolean>>();
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: SshConfigDeps,
  ) {}

  getGeneration(): number {
    return this.deps.getGeneration();
  }

  /** Trust-on-first-use for the managed SSH connections. A changed key is never accepted by this attempt. */
  async verifyHostKey(host: string, port: number, key: Buffer): Promise<boolean> {
    const generation = this.deps.getGeneration();
    const id = JSON.stringify([host, port]);
    const previous = this.hostKeyChecks.get(id) ?? Promise.resolve(false);
    const pending = previous.catch(() => false).then(() => this.checkHostKey(host, port, key, generation));
    this.hostKeyChecks.set(id, pending);
    try {
      return await pending;
    } finally {
      if (this.hostKeyChecks.get(id) === pending) this.hostKeyChecks.delete(id);
    }
  }

  private async checkHostKey(host: string, port: number, key: Buffer, generation: number): Promise<boolean> {
    if (generation !== this.deps.getGeneration()) return false;
    const id = JSON.stringify([host, port]);
    const encoded = key.toString("base64");
    const keys = this.context.globalState.get<Record<string, string>>(HOST_KEYS_KEY, {});
    if (keys[id] === encoded) return generation === this.deps.getGeneration();
    const fingerprint = createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
    if (keys[id]) {
      const RESET = "Сбросить доверие…";
      const choice = await vscode.window.showErrorMessage(
        `SSH-ключ сервера ${host}:${port} изменился (SHA256:${fingerprint}). Подключение отклонено. Проверьте новый отпечаток у администратора Cloud.ru перед сбросом доверия.`,
        RESET,
      );
      if (choice === RESET && generation === this.deps.getGeneration()) {
        const CONFIRM = "Сбросить";
        const confirmed = await vscode.window.showWarningMessage(
          `После сброса следующее подключение к ${host}:${port} снова запросит подтверждение ключа. Сначала проверьте SHA256:${fingerprint} у администратора Cloud.ru.`,
          { modal: true },
          CONFIRM,
        );
        if (confirmed === CONFIRM && generation === this.deps.getGeneration()) {
          const latest = { ...this.context.globalState.get<Record<string, string>>(HOST_KEYS_KEY, {}) };
          delete latest[id];
          await this.context.globalState.update(HOST_KEYS_KEY, latest);
        }
      }
      return false;
    }
    const TRUST = "Доверять ключу";
    const choice = await vscode.window.showWarningMessage(
      `Первое SSH-подключение к ${host}:${port}. Проверьте отпечаток ключа сервера у администратора Cloud.ru: SHA256:${fingerprint}`,
      { modal: true },
      TRUST,
    );
    if (choice !== TRUST || generation !== this.deps.getGeneration()) return false;
    const latest = this.context.globalState.get<Record<string, string>>(HOST_KEYS_KEY, {});
    if (latest[id] && latest[id] !== encoded) return false;
    await this.context.globalState.update(HOST_KEYS_KEY, { ...latest, [id]: encoded });
    return generation === this.deps.getGeneration();
  }

  trustedHostKeyLine(host: string, port: number): string | undefined {
    const encoded = this.context.globalState.get<Record<string, string>>(HOST_KEYS_KEY, {})[JSON.stringify([host, port])];
    if (!encoded) return undefined;
    const parsed = sshUtils.parseKey(Buffer.from(encoded, "base64"));
    if (parsed instanceof Error) return undefined;
    return `[${host}]:${port} ${parsed.type} ${encoded}`;
  }

  /** Build the SSH target for a notebook. With `interactive: false` (the kernel picker) it never opens
   * a dialog — it uses only already-configured key/endpoint and returns undefined otherwise. */
  async resolveTarget(
    notebook: NotebookHandlerResponse,
    opts: { interactive?: boolean } = {},
  ): Promise<SshConnectionConfig | undefined> {
    if (!notebook.url) return undefined;
    const workspace = this.deps.getWorkspace();
    const generation = this.deps.getGeneration();
    if (!workspace || !(await this.deps.isSignedIn())) return undefined;
    const interactive = opts.interactive ?? true;

    const privateKey = interactive ? await this.ensurePrivateKey() : this.loadPrivateKey();
    if (!privateKey) return undefined;
    const endpoint = await this.ensureEndpoint(notebook, interactive);
    if (!endpoint) return undefined;
    if (generation !== this.deps.getGeneration()) return undefined;

    const target: PersistedTarget = {
      workspaceId: workspace.workspaceId,
      host: endpoint.host,
      port: endpoint.port,
      username: buildUsername(notebook.name, endpoint.accountId),
    };
    await this.saveTarget(notebook.uid, target);
    this.deps.logger.info(
      `[ssh] final command for "${notebook.name}": ssh ${target.username}@${target.host} -p ${target.port} -i <key>`,
    );
    return { ...target, privateKey, verifyHostKey: (key) => this.verifyHostKey(target.host, target.port, key) };
  }

  /**
   * Rebuild a target for a previously-mounted notebook without any prompts (used by the file system
   * provider to reconnect after an extension-host reload). Returns undefined if config is missing.
   */
  async resolveSilently(uid: string): Promise<SshConnectionConfig | undefined> {
    const generation = this.deps.getGeneration();
    if (!(await this.deps.isSignedIn())) return undefined;
    const workspaceId = this.deps.getWorkspace()?.workspaceId;
    if (!workspaceId) return undefined;
    const target = this.loadTarget(uid);
    if (!target || target.workspaceId !== workspaceId) return undefined;
    const privateKey = this.loadPrivateKey();
    if (!privateKey || generation !== this.deps.getGeneration()) return undefined;
    return { ...target, privateKey, verifyHostKey: (key) => this.verifyHostKey(target.host, target.port, key) };
  }

  /** SSH details for an `~/.ssh/config` Host entry used by Remote-SSH (full IDE mode). */
  async resolveConfigEntry(
    notebook: NotebookHandlerResponse,
  ): Promise<{ host: string; port: number; username: string; identityFile: string } | undefined> {
    if (!notebook.url) return undefined;
    const generation = this.deps.getGeneration();
    if (!this.deps.getWorkspace() || !(await this.deps.isSignedIn())) return undefined;

    const identityFile = await this.ensureKeyPath();
    if (!identityFile || generation !== this.deps.getGeneration()) return undefined;
    const endpoint = await this.ensureEndpoint(notebook, true);
    if (!endpoint || generation !== this.deps.getGeneration()) return undefined;

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
  async configure(): Promise<boolean> {
    if (!(await this.pickPrivateKey())) return false;
    await this.context.globalState.update(ENDPOINTS_KEY, {});
    await this.context.globalState.update(TARGETS_KEY, {});
    return true;
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
      title: "Выберите приватный SSH-ключ Distributed Train (скачан из консоли)",
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

  /** When no key is configured, ask how to provide one — generate via the API, upload your own
   * public key, or pick an existing file — rather than dropping the user straight into a file dialog.
   * Returns the resolved private-key path. */
  private async obtainKeyPath(): Promise<string | undefined> {
    const GENERATE = "Сгенерировать новый ключ (старый перестанет работать)";
    const UPLOAD = "Загрузить свой публичный ключ…";
    const PICK = "Выбрать файл ключа…";
    const choice = await vscode.window.showQuickPick([GENERATE, UPLOAD, PICK], {
      title: "SSH-ключ Distributed Train не настроен",
      placeHolder: "Как получить ключ для доступа к ноутбукам по SSH?",
      ignoreFocusOut: true,
    });
    if (choice === GENERATE) return this.generateKey();
    if (choice === UPLOAD) return this.uploadOwnPublicKey();
    if (choice === PICK) return this.pickPrivateKey();
    return undefined;
  }

  /**
   * Upload the user's own public key (`*.pub`) to Distributed Train via
   * POST /user/v1/user_ssh_keys/public_key — the console's "загрузить свой ключ" path. The private
   * half never leaves the machine; afterwards the user points the extension at that private key.
   * Returns the chosen private-key path (undefined on cancel/failure).
   */
  async uploadOwnPublicKey(): Promise<string | undefined> {
    const ws = this.deps.getWorkspace();
    const generation = this.deps.getGeneration();
    if (!ws || !(await this.deps.isSignedIn())) {
      void vscode.window.showWarningMessage("Сначала выберите воркспейс Cloud.ru.");
      return undefined;
    }
    const CONFIRM = "Загрузить";
    const ok = await vscode.window.showWarningMessage(
      "Публичный ключ заменит текущий ключ Distributed Train: ранее сгенерированный ключ перестанет работать.",
      { modal: true },
      CONFIRM,
    );
    if (ok !== CONFIRM) return undefined;

    const picked = await vscode.window.showOpenDialog({
      title: "Выберите файл публичного ключа (*.pub)",
      canSelectMany: false,
      openLabel: "Загрузить публичный ключ",
      filters: { "Публичные ключи": ["pub", "txt"] },
    });
    const pubPath = picked?.[0]?.fsPath;
    if (!pubPath) return undefined;
    const privatePicked = await vscode.window.showOpenDialog({
      title: "Выберите приватную половину этого ключа",
      canSelectMany: false,
      openLabel: "Использовать приватный ключ",
    });
    const privatePath = privatePicked?.[0]?.fsPath;
    if (!privatePath) return undefined;
    let publicKey: string;
    let privateKey: Buffer;
    try {
      publicKey = (await fs.promises.readFile(pubPath, "utf8")).trim();
      privateKey = await fs.promises.readFile(privatePath);
      const parsedPublic = sshUtils.parseKey(publicKey);
      const parsedPrivate = sshUtils.parseKey(privateKey);
      if (parsedPublic instanceof Error) throw parsedPublic;
      if (parsedPrivate instanceof Error) throw new Error(`Приватный ключ не поддерживается или зашифрован: ${parsedPrivate.message}`);
      if (!parsedPrivate.isPrivateKey() || !parsedPrivate.equals(parsedPublic)) {
        throw new Error("Публичный и приватный ключи не образуют пару");
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Не удалось проверить пару SSH-ключей: ${(err as Error).message}`);
      return undefined;
    }
    if (generation !== this.deps.getGeneration()) return undefined;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Загрузка публичного ключа…" },
        () => this.deps.client.uploadUserPublicKey(ws, publicKey),
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`Не удалось загрузить публичный ключ: ${(err as Error).message}`);
      return undefined;
    }
    if (generation !== this.deps.getGeneration()) {
      void vscode.window.showWarningMessage("Ключ загружен в прежний воркспейс. Выберите его снова перед настройкой SSH.");
      return undefined;
    }
    try {
      await vscode.workspace.getConfiguration("cloudru").update("ssh.privateKeyPath", privatePath, vscode.ConfigurationTarget.Global);
    } catch (err) {
      void vscode.window.showErrorMessage(`Публичный ключ уже загружен в Cloud.ru, но локальная настройка не сохранена: ${(err as Error).message}`);
      return undefined;
    }
    void vscode.window.showInformationMessage("SSH-ключ загружен и приватная половина настроена.");
    return privatePath;
  }

  /** Generate a fresh SSH key via the console API, store it 0600 under globalStorage, point the config
   * at it, and offer to save a copy. Returns the stored path (undefined on failure). */
  async generateKey(): Promise<string | undefined> {
    const ws = this.deps.getWorkspace();
    const generation = this.deps.getGeneration();
    if (!ws || !(await this.deps.isSignedIn())) {
      void vscode.window.showWarningMessage("Сначала выберите воркспейс Cloud.ru.");
      return undefined;
    }
    if (generation !== this.deps.getGeneration()) return undefined;
    const dest = vscode.Uri.joinPath(this.context.globalStorageUri, "ssh", `mlspace-${encodeURIComponent(ws.workspaceId)}.private_key`).fsPath;
    try {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    } catch (err) {
      void vscode.window.showErrorMessage(`Не удалось подготовить хранилище SSH-ключа: ${(err as Error).message}`);
      return undefined;
    }
    if (generation !== this.deps.getGeneration()) return undefined;
    const pair = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Генерация SSH-ключа…" },
      () => this.deps.client.generateSshKey(ws),
    );
    if (!pair.private_key) {
      void vscode.window.showErrorMessage("Сервер не вернул приватный ключ.");
      return undefined;
    }
    try {
      await fs.promises.writeFile(dest, withTrailingNewline(pair.private_key), { mode: 0o600 });
      await fs.promises.chmod(dest, 0o600);
    } catch (err) {
      this.deps.logger.error("[ssh] failed to store generated key", err);
      void vscode.window.showErrorMessage(`Новый ключ уже создан в Cloud.ru, но не сохранён локально: ${(err as Error).message}`);
      return undefined;
    }
    if (generation !== this.deps.getGeneration()) {
      void vscode.window.showWarningMessage(`Ключ создан для прежнего воркспейса и сохранён в ${dest}. Выберите его после возврата к этому воркспейсу.`);
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
      defaultUri: vscode.Uri.file("distributed_train_ssh_key"),
    });
    if (!uri) return;
    try {
      await fs.promises.writeFile(uri.fsPath, withTrailingNewline(privateKey), { mode: 0o600 });
      await fs.promises.chmod(uri.fsPath, 0o600);
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
    const ws = this.deps.getWorkspace();
    const key = ws?.namespace ? JSON.stringify([ws.workspaceId, ws.namespace, region]) : undefined;
    const override = key ? this.context.globalState.get<Record<string, SshEndpoint>>(ENDPOINTS_KEY, {})[key] : undefined;
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
    const generation = this.deps.getGeneration();
    const endpoint = await this.promptEndpoint();
    if (generation !== this.deps.getGeneration()) return undefined;
    if (endpoint) await this.saveEndpoint(notebook.region || "", endpoint);
    return endpoint;
  }

  private async saveEndpoint(region: string, endpoint: SshEndpoint): Promise<void> {
    const ws = this.deps.getWorkspace();
    if (!ws?.namespace) return; // an account-less selection cannot own a reusable override safely
    const all = this.context.globalState.get<Record<string, SshEndpoint>>(ENDPOINTS_KEY, {});
    all[JSON.stringify([ws.workspaceId, ws.namespace, region])] = endpoint;
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
