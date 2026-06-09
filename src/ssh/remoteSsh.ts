import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { NotebookHandlerResponse } from "../api/types";
import type { Logger } from "../util/logger";
import type { SshConfig } from "./sshConfig";
import { formatHostStanza, type SshHostEntry, upsertSshConfigBlock } from "./sshConfigFile";

const REMOTE_SSH_EXT = "ms-vscode-remote.remote-ssh";
const REMOTE_HOME = "/home/jovyan";

/** Open a notebook as a full remote-dev window via the Remote-SSH extension (terminal + IntelliSense). */
export async function openFullIde(
  notebook: NotebookHandlerResponse,
  sshConfig: SshConfig,
  context: vscode.ExtensionContext,
  logger: Logger,
): Promise<void> {
  if (notebook.status !== "running" || !notebook.url) {
    void vscode.window.showWarningMessage(
      `Notebook “${notebook.name}” is ${notebook.status}; it must be running to open the full IDE.`,
    );
    return;
  }
  if (!vscode.extensions.getExtension(REMOTE_SSH_EXT)) {
    const action = "Install Remote-SSH";
    const picked = await vscode.window.showWarningMessage(
      "The Remote-SSH extension is required for the full IDE mode.",
      action,
    );
    if (picked === action) {
      void vscode.commands.executeCommand(
        "workbench.extensions.installExtension",
        REMOTE_SSH_EXT,
      );
    }
    return;
  }

  const entry = await sshConfig.resolveConfigEntry(notebook);
  if (!entry) return;

  const alias = `cloudru-${notebook.uid}`;
  try {
    await ensureHostEntry(alias, entry, context);
  } catch (err) {
    logger.error("Failed to update ~/.ssh/config", err);
    void vscode.window.showErrorMessage(`Could not write SSH config: ${(err as Error).message}`);
    return;
  }

  const uri = vscode.Uri.parse(`vscode-remote://ssh-remote+${alias}${REMOTE_HOME}`);
  logger.info(`Opening full IDE for ${notebook.name} → ${uri.toString()}`);
  await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: true });
}

async function ensureHostEntry(
  alias: string,
  entry: SshHostEntry,
  context: vscode.ExtensionContext,
): Promise<void> {
  const sshDir = path.join(os.homedir(), ".ssh");
  await fs.mkdir(sshDir, { recursive: true });
  const configPath = path.join(sshDir, "config");

  const knownHosts = path.join(context.globalStorageUri.fsPath, "known_hosts");
  await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });

  let existing = "";
  try {
    existing = await fs.readFile(configPath, "utf8");
  } catch {
    // no config yet
  }
  const next = upsertSshConfigBlock(existing, alias, formatHostStanza(alias, entry, knownHosts));
  await fs.writeFile(configPath, next, { mode: 0o600 });
}
