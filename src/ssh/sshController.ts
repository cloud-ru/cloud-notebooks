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
    const target = await this.deps.config.resolveTarget(notebook);
    if (!target) return "no-config";
    this.deps.provider.register(notebook.uid, target);
    try {
      const root = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Connecting to ${notebook.name} over SSH…` },
        () => this.deps.provider.resolveHome(notebook.uid),
      );
      this.mount(notebook, root);
      return "ok";
    } catch (err) {
      this.deps.logger.error(`SSH connect failed for ${target.host}`, err);
      return "failed";
    }
  }

  /** Re-pick the private key and forget cached SSH endpoints. */
  async configure(): Promise<void> {
    await this.deps.config.configure();
  }

  /** Generate a new Distributed Train SSH key via the API and configure the extension to use it. */
  generateKey(): Promise<string | undefined> {
    return this.deps.config.generateKey();
  }

  /** Upload a user-owned public key to Distributed Train and point the extension at its private half. */
  uploadOwnPublicKey(): Promise<string | undefined> {
    return this.deps.config.uploadOwnPublicKey();
  }

  private mount(notebook: NotebookHandlerResponse, root: string): void {
    const uri = vscode.Uri.from({ scheme: SSH_SCHEME, authority: notebook.uid, path: root || "/" });
    const start = vscode.workspace.workspaceFolders?.length ?? 0;
    vscode.workspace.updateWorkspaceFolders(start, 0, { uri, name: `${notebook.name} (SSH)` });
    void vscode.commands.executeCommand("revealInExplorer", uri);
    this.deps.logger.info(`Mounted ${notebook.name} at ${uri.toString()}`);
  }
}
