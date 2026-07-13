import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { NotebookHandlerResponse } from "../api/types";
import type { Logger } from "../util/logger";
import type { SshConfig } from "./sshConfig";
import { formatHostStanza, type SshHostEntry, upsertSshConfigBlock } from "./sshConfigFile";

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
      `«${notebook.name}»: ${notebook.status}. Ноутбук должен быть запущен, чтобы открыть полный IDE.`,
    );
    return;
  }
  // Detect any Remote-SSH flavour (official `ms-vscode-remote.remote-ssh`, plus fork equivalents like
  // `jeanp413.open-remote-ssh` / `anysphere.remote-ssh`). Only warn — never block — since the id varies
  // across editors and `vscode-remote://` is resolved by whichever provider is installed.
  const hasRemoteSsh = vscode.extensions.all.some((ext) => /remote-ssh/i.test(ext.id));
  if (!hasRemoteSsh) {
    void vscode.window.showWarningMessage(
      "Не найдено расширение Remote-SSH. Если окно не подключится, установите «Remote - SSH» (или аналог для вашего редактора).",
    );
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
