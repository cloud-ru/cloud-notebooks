import * as vscode from "vscode";
import type { NotebookHandlerResponse } from "../api/types";
import type { Logger } from "../util/logger";
import { CloudruSshFsProvider, SSH_SCHEME } from "./sftpFs";
import type { SshConfig } from "./sshConfig";
import { openFullIde } from "./remoteSsh";

/**
 * Orchestrates the SSH features: mounts a notebook's home as a workspace folder over SFTP (file
 * browser) and hands off to Remote-SSH for the full IDE (terminal + remote IntelliSense).
 */
export class SshController {
  constructor(
    private readonly deps: {
      provider: CloudruSshFsProvider;
      config: SshConfig;
      context: vscode.ExtensionContext;
      logger: Logger;
      getGeneration: () => number;
    },
  ) {}

  /** Open the notebook as a full remote-dev window (Remote-SSH). */
  openFullIde(notebook: NotebookHandlerResponse): Promise<void> {
    return openFullIde(notebook, this.deps.config, this.deps.context, this.deps.logger);
  }

  async openFiles(notebook: NotebookHandlerResponse): Promise<void> {
    if (notebook.status !== "running" || !notebook.url) {
      void vscode.window.showWarningMessage(
        `«${notebook.name}»: ${notebook.status}. Для просмотра файлов ноутбук должен быть запущен.`,
      );
      return;
    }

    if ((await this.connectAndMount(notebook)) !== "failed") return;

    // The auto-derived endpoint may be wrong (e.g. an older gateway scheme). Offer a manual SSH command
    // override or the SSH settings, then retry; the override then wins for the whole region.
    const ENTER = "Ввести SSH-команду";
    const CONFIGURE = "Настроить SSH";
    const choice = await vscode.window.showErrorMessage(
      `Не удалось подключиться к «${notebook.name}» по SSH.`,
      ENTER,
      CONFIGURE,
    );
    if (choice === CONFIGURE) {
      await this.configure();
      return;
    }
    if (choice !== ENTER) return;
    if (!(await this.deps.config.captureEndpoint(notebook))) return;
    if ((await this.connectAndMount(notebook)) === "failed") {
      void vscode.window.showErrorMessage(`Подключение к «${notebook.name}» по SSH снова не удалось.`);
    }
  }

  /** Resolve the target, open the SFTP channel and mount the home folder. `"no-config"` means the
   * user cancelled a prompt (no recovery offered); `"failed"` means the connection itself failed. */
  private async connectAndMount(
    notebook: NotebookHandlerResponse,
  ): Promise<"ok" | "no-config" | "failed"> {
    const generation = this.deps.getGeneration();
    const target = await this.deps.config.resolveTarget(notebook);
    if (!target || generation !== this.deps.getGeneration()) return "no-config";
    this.deps.provider.register(notebook.uid, target);
    try {
      const root = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Подключение к «${notebook.name}» по SSH…` },
        () => this.deps.provider.resolveHome(notebook.uid),
      );
      if (generation !== this.deps.getGeneration()) {
        this.deps.provider.invalidate(notebook.uid);
        return "no-config";
      }
      if (!this.mount(notebook, root)) return "no-config";
      return "ok";
    } catch (err) {
      this.deps.logger.error(`SSH connect failed for ${target.host}`, err);
      return "failed";
    }
  }

  /** Re-pick the private key and forget cached SSH endpoints. */
  async configure(): Promise<void> {
    if (await this.deps.config.configure()) this.deps.provider.reset();
  }

  invalidate(uid: string): void {
    this.deps.provider.invalidate(uid);
  }

  /** Generate a new Distributed Train SSH key via the API and configure the extension to use it. */
  async generateKey(): Promise<string | undefined> {
    const keyPath = await this.deps.config.generateKey();
    if (keyPath) this.deps.provider.reset();
    return keyPath;
  }

  /** Upload a user-owned public key to Distributed Train and point the extension at its private half. */
  async uploadOwnPublicKey(): Promise<string | undefined> {
    const keyPath = await this.deps.config.uploadOwnPublicKey();
    if (keyPath) this.deps.provider.reset();
    return keyPath;
  }

  private mount(notebook: NotebookHandlerResponse, root: string): boolean {
    const uri = vscode.Uri.from({ scheme: SSH_SCHEME, authority: notebook.uid, path: root || "/" });
    if (vscode.workspace.workspaceFolders?.some((folder) => folder.uri.toString() === uri.toString())) {
      void vscode.commands.executeCommand("revealInExplorer", uri);
      return true;
    }
    const start = vscode.workspace.workspaceFolders?.length ?? 0;
    if (!vscode.workspace.updateWorkspaceFolders(start, 0, { uri, name: `${notebook.name} (SSH)` })) {
      void vscode.window.showErrorMessage(`Не удалось добавить файлы «${notebook.name}» в рабочую область редактора.`);
      return false;
    }
    void vscode.commands.executeCommand("revealInExplorer", uri);
    this.deps.logger.info(`Mounted ${notebook.name} at ${uri.toString()}`);
    return true;
  }
}
