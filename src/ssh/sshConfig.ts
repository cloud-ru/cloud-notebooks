import * as fs from "node:fs";
import * as vscode from "vscode";
import type { NotebookHandlerResponse } from "../api/types";
import type { SshConnectionConfig } from "./connection";
import {
  buildUsername,
  DEFAULT_SSH_HOST_TEMPLATE,
  DEFAULT_SSH_PORT,
  deriveSshHost,
  parseSshCommand,
} from "./sshUrl";

const ACCOUNT_ID_KEY = "cloudru.ssh.accountId";
const TARGETS_KEY = "cloudru.ssh.targets";

interface PersistedTarget {
  host: string;
  port: number;
  username: string;
}

/**
 * Captures and resolves the one-time SSH inputs that are not in the public API — the private key
 * (downloaded from the console) and the auto-generated account id — and derives the per-notebook SSH
 * target. Shared by the file browser (SFTP) and the remote kernel (port forward).
 */
export class SshConfig {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Build the SSH target for a notebook, prompting for key/account id if needed. */
  async resolveTarget(notebook: NotebookHandlerResponse): Promise<SshConnectionConfig | undefined> {
    if (!notebook.url) return undefined;

    const privateKey = await this.ensurePrivateKey();
    if (!privateKey) return undefined;
    const accountId = await this.ensureAccountId();
    if (!accountId) return undefined;

    const config = vscode.workspace.getConfiguration("cloudru");
    const template = config.get<string>("ssh.hostTemplate", DEFAULT_SSH_HOST_TEMPLATE);
    const port = config.get<number>("ssh.port", DEFAULT_SSH_PORT);
    const host = deriveSshHost(notebook.url, template);
    if (!host) {
      void vscode.window.showErrorMessage(`Could not derive the SSH host from ${notebook.url}.`);
      return undefined;
    }
    const username = buildUsername(notebook.name, accountId);
    await this.saveTarget(notebook.uid, { host, port, username });
    return { host, port, username, privateKey };
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
    const accountId = await this.ensureAccountId();
    if (!accountId) return undefined;

    const config = vscode.workspace.getConfiguration("cloudru");
    const host = deriveSshHost(notebook.url, config.get<string>("ssh.hostTemplate", DEFAULT_SSH_HOST_TEMPLATE));
    if (!host) {
      void vscode.window.showErrorMessage(`Could not derive the SSH host from ${notebook.url}.`);
      return undefined;
    }
    return {
      host,
      port: config.get<number>("ssh.port", DEFAULT_SSH_PORT),
      username: buildUsername(notebook.name, accountId),
      identityFile,
    };
  }

  /** Path to the configured private key, prompting to pick one if not set. */
  private async ensureKeyPath(): Promise<string | undefined> {
    const path = vscode.workspace.getConfiguration("cloudru").get<string>("ssh.privateKeyPath", "");
    return path || (await this.pickPrivateKey());
  }

  private async saveTarget(uid: string, target: PersistedTarget): Promise<void> {
    const all = this.context.globalState.get<Record<string, PersistedTarget>>(TARGETS_KEY, {});
    all[uid] = target;
    await this.context.globalState.update(TARGETS_KEY, all);
  }

  private loadTarget(uid: string): PersistedTarget | undefined {
    return this.context.globalState.get<Record<string, PersistedTarget>>(TARGETS_KEY, {})[uid];
  }

  /** Re-enter the private key and account id (explicit "Configure SSH" command). */
  async configure(): Promise<void> {
    await this.pickPrivateKey();
    await this.promptAccountId();
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

  private async ensureAccountId(): Promise<string | undefined> {
    const stored = this.context.globalState.get<string>(ACCOUNT_ID_KEY);
    if (stored) return stored;
    return this.promptAccountId();
  }

  private async promptAccountId(): Promise<string | undefined> {
    const input = await vscode.window.showInputBox({
      title: "Cloud.ru SSH — connection command or account id",
      prompt:
        "Paste the SSH command from the console (you can drop the “-i <key>” part — the key file you " +
        "picked is used). Only the account id is read from it. You may also just type the account id.",
      placeHolder: "ssh name.ai0000000-00000@ssh-a100-jupyter.ai.cloud.ru -p 2222   ·   or just  ai0000000-00000",
      ignoreFocusOut: true,
    });
    if (!input) return undefined;

    const trimmed = input.trim();
    const accountId = trimmed.includes("@")
      ? parseSshCommand(trimmed)?.accountId
      : /^[A-Za-z]+\d+-\d+$/.test(trimmed)
        ? trimmed
        : undefined;
    if (!accountId) {
      void vscode.window.showErrorMessage(
        "Could not read the account id. Paste the full SSH command, or just the id (e.g. ai0000000-00000).",
      );
      return undefined;
    }
    await this.context.globalState.update(ACCOUNT_ID_KEY, accountId);
    return accountId;
  }
}
