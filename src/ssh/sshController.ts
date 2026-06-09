import * as vscode from "vscode";
import type { NotebookHandlerResponse } from "../api/types";
import type { Logger } from "../util/logger";
import { CloudruSshFsProvider, SSH_SCHEME } from "./sftpFs";
import type { SshConfig } from "./sshConfig";

/**
 * Orchestrates the SSH file browser: resolves the SSH target via {@link SshConfig} and mounts a
 * notebook's home directory as a workspace folder backed by the SFTP `FileSystemProvider`.
 */
export class SshController {
  constructor(
    private readonly deps: {
      provider: CloudruSshFsProvider;
      config: SshConfig;
      logger: Logger;
    },
  ) {}

  async openFiles(notebook: NotebookHandlerResponse): Promise<void> {
    if (notebook.status !== "running" || !notebook.url) {
      void vscode.window.showWarningMessage(
        `Notebook “${notebook.name}” is ${notebook.status}; it must be running to browse its files.`,
      );
      return;
    }

    const target = await this.deps.config.resolveTarget(notebook);
    if (!target) return;
    this.deps.provider.register(notebook.uid, target);

    try {
      const root = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Connecting to ${notebook.name} over SSH…` },
        () => this.deps.provider.resolveHome(notebook.uid),
      );
      this.mount(notebook, root);
    } catch (err) {
      this.deps.logger.error(`SSH connect failed for ${target.host}`, err);
      void vscode.window.showErrorMessage(`SSH connection failed: ${(err as Error).message}`);
    }
  }

  /** Re-enter the private key and account id. */
  async configure(): Promise<void> {
    await this.deps.config.configure();
  }

  private mount(notebook: NotebookHandlerResponse, root: string): void {
    const uri = vscode.Uri.from({ scheme: SSH_SCHEME, authority: notebook.uid, path: root || "/" });
    const start = vscode.workspace.workspaceFolders?.length ?? 0;
    vscode.workspace.updateWorkspaceFolders(start, 0, { uri, name: `${notebook.name} (SSH)` });
    void vscode.commands.executeCommand("revealInExplorer", uri);
    this.deps.logger.info(`Mounted ${notebook.name} at ${uri.toString()}`);
  }
}
