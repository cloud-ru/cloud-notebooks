import * as fs from "node:fs";
import * as vscode from "vscode";
import type { NotebookHandlerResponse } from "../api/types";
import type { Logger } from "../util/logger";
import { CloudruSshFsProvider, SSH_SCHEME } from "./sftpFs";
import {
  buildUsername,
  DEFAULT_SSH_HOST_TEMPLATE,
  DEFAULT_SSH_PORT,
  deriveSshHost,
  parseSshCommand,
} from "./sshUrl";

const ACCOUNT_ID_KEY = "cloudru.ssh.accountId";

/**
 * Orchestrates the SSH file browser: captures the one-time config (private key + account id), mounts a
 * notebook's home directory as a workspace folder backed by the SFTP `FileSystemProvider`.
 */
export class SshController {
  constructor(
    private readonly deps: {
      provider: CloudruSshFsProvider;
      context: vscode.ExtensionContext;
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

    const privateKey = await this.ensurePrivateKey();
    if (!privateKey) return;
    const accountId = await this.ensureAccountId();
    if (!accountId) return;

    const config = vscode.workspace.getConfiguration("cloudru");
    const template = config.get<string>("ssh.hostTemplate", DEFAULT_SSH_HOST_TEMPLATE);
    const port = config.get<number>("ssh.port", DEFAULT_SSH_PORT);
    const host = deriveSshHost(notebook.url, template);
    if (!host) {
      void vscode.window.showErrorMessage(`Could not derive the SSH host from ${notebook.url}.`);
      return;
    }

    const username = buildUsername(notebook.name, accountId);
    this.deps.provider.register(notebook.uid, { host, port, username, privateKey });

    try {
      const root = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Connecting to ${notebook.name} over SSH…` },
        () => this.deps.provider.resolveHome(notebook.uid),
      );
      this.mount(notebook, root);
    } catch (err) {
      this.deps.logger.error(`SSH connect failed for ${host}`, err);
      void vscode.window.showErrorMessage(`SSH connection failed: ${(err as Error).message}`);
    }
  }

  /** Re-enter the private key and account id. */
  async configure(): Promise<void> {
    await this.pickPrivateKey();
    await this.promptAccountId();
  }

  private mount(notebook: NotebookHandlerResponse, root: string): void {
    const uri = vscode.Uri.from({ scheme: SSH_SCHEME, authority: notebook.uid, path: root || "/" });
    const start = vscode.workspace.workspaceFolders?.length ?? 0;
    vscode.workspace.updateWorkspaceFolders(start, 0, { uri, name: `${notebook.name} (SSH)` });
    void vscode.commands.executeCommand("revealInExplorer", uri);
    this.deps.logger.info(`Mounted ${notebook.name} at ${uri.toString()}`);
  }

  private async ensurePrivateKey(): Promise<Buffer | undefined> {
    let path = vscode.workspace.getConfiguration("cloudru").get<string>("ssh.privateKeyPath", "");
    if (!path) path = (await this.pickPrivateKey()) ?? "";
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

  private async ensureAccountId(): Promise<string | undefined> {
    const stored = this.deps.context.workspaceState.get<string>(ACCOUNT_ID_KEY);
    if (stored) return stored;
    return this.promptAccountId();
  }

  private async promptAccountId(): Promise<string | undefined> {
    const command = await vscode.window.showInputBox({
      title: "Cloud.ru SSH — paste the connection command",
      prompt: "Paste the SSH command from the console (Jupyter Servers → ⋮ → SSH).",
      placeHolder: "ssh name.ai0000000-00000@ssh-a100-jupyter.ai.cloud.ru -p 2222 -i <key>",
      ignoreFocusOut: true,
    });
    if (!command) return undefined;
    const parsed = parseSshCommand(command);
    if (!parsed) {
      void vscode.window.showErrorMessage("Could not parse the SSH command. Expected user@host with a dot in the user.");
      return undefined;
    }
    await this.deps.context.workspaceState.update(ACCOUNT_ID_KEY, parsed.accountId);
    return parsed.accountId;
  }
}
