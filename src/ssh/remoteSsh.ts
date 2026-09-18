import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { NotebookHandlerResponse } from "../api/types";
import type { Logger } from "../util/logger";
import type { SshConfig } from "./sshConfig";
import { SshConnection } from "./connection";
import { formatHostStanza, type SshHostEntry, upsertSshConfigBlock } from "./sshConfigFile";
import { parseProductJson, preseedServer, type ProductInfo } from "./serverPreseed";

const REMOTE_HOME = "/home/jovyan";
let configUpdate: Promise<void> = Promise.resolve();

/** Open a notebook as a full remote-dev window via the Remote-SSH extension (terminal + IntelliSense). */
export async function openFullIde(
  notebook: NotebookHandlerResponse,
  sshConfig: SshConfig,
  context: vscode.ExtensionContext,
  logger: Logger,
): Promise<void> {
  const generation = sshConfig.getGeneration();
  const isCurrent = () => generation === sshConfig.getGeneration();
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
  if (!entry || !isCurrent()) return;

  let privateKey: Buffer;
  try {
    privateKey = await fs.readFile(entry.identityFile);
  } catch (err) {
    void vscode.window.showErrorMessage(`Не удалось прочитать SSH-ключ ${entry.identityFile}: ${errorMessage(err)}`);
    return;
  }
  if (!isCurrent()) return;
  const trustConnection = new SshConnection({
    host: entry.host,
    port: entry.port,
    username: entry.username,
    privateKey,
    verifyHostKey: (key) => sshConfig.verifyHostKey(entry.host, entry.port, key),
  });
  try {
    await trustConnection.sftp();
  } catch (err) {
    logger.error("SSH host verification failed", err);
    void vscode.window.showErrorMessage(`Не удалось проверить SSH-сервер ${entry.host}:${entry.port}: ${errorMessage(err)}`);
    return;
  } finally {
    trustConnection.dispose();
  }
  if (!isCurrent()) return;
  const hostKeyLine = sshConfig.trustedHostKeyLine(entry.host, entry.port);
  if (!hostKeyLine) return;

  const alias = `cloudru-${notebook.uid}`;
  try {
    await ensureHostEntry(alias, entry, context, hostKeyLine, isCurrent);
  } catch (err) {
    logger.error("Failed to update ~/.ssh/config", err);
    void vscode.window.showErrorMessage(`Could not write SSH config: ${errorMessage(err)}`);
    return;
  }
  if (!isCurrent()) return;
  // Pods have throttled egress to the VS Code CDN, so pre-seed over our SSH gateway first.
  // A preparation error falls back to Remote-SSH; cancellation stops the entire open action.
  const proceed = await preseedVsCodeServer(entry, context, logger, (key) => sshConfig.verifyHostKey(entry.host, entry.port, key));
  if (!proceed || !isCurrent()) return;

  const uri = vscode.Uri.parse(`vscode-remote://ssh-remote+${alias}${REMOTE_HOME}`);
  logger.info(`Opening full IDE for ${notebook.name} → ${uri.toString()}`);
  await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: true });
}
/** Best-effort server pre-seed with a cancellable progress notification. Never throws. */
async function preseedVsCodeServer(
  entry: SshHostEntry,
  context: vscode.ExtensionContext,
  logger: Logger,
  verifyHostKey: (key: Buffer) => Promise<boolean>,
): Promise<boolean> {
  let product: ProductInfo | undefined;
  try {
    product = parseProductJson(await fs.readFile(path.join(vscode.env.appRoot, "product.json"), "utf8"));
  } catch (err) {
    logger.warn(`[preseed] cannot read product.json: ${errorMessage(err)}`);
    return true;
  }
  if (!product) {
    logger.info("[preseed] client product is not pre-seedable (no commit or unknown update endpoint); skipping");
    return true;
  }

  let privateKey: Buffer;
  try {
    privateKey = await fs.readFile(entry.identityFile);
  } catch (err) {
    logger.warn(`[preseed] cannot read key ${entry.identityFile}: ${errorMessage(err)}`);
    return true;
  }

  const connection = new SshConnection({
    host: entry.host,
    port: entry.port,
    username: entry.username,
    privateKey,
    verifyHostKey,
  });
  let cancelled = false;
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Cloud.ru: подготовка VS Code Server на ноутбуке…",
        cancellable: true,
      },
      async (progress, token) => {
        const controller = new AbortController();
        if (token.isCancellationRequested) controller.abort();
        const subscription = token.onCancellationRequested(() => { cancelled = true; controller.abort(); });
        let lastPercent = 0;
        try {
          const result = await preseedServer({
            product,
            exec: (command, stdin, signal, deadlineMs) => connection.exec(command, stdin, signal, deadlineMs),
            sftp: () => connection.sftp(),
            cacheDir: path.join(context.globalStorageUri.fsPath, "server-cache"),
            signal: controller.signal,
            log: logger,
            report: (message, percent) => {
              progress.report({ message, increment: Math.max(0, percent - lastPercent) });
              lastPercent = Math.max(lastPercent, percent);
            },
          });
          switch (result.status) {
            case "skipped":
              logger.info(`[preseed] skipped: ${result.reason}`);
              break;
            case "deferred":
              logger.info("[preseed] slow download detached to background; cache will be ready on a later connect");
              void vscode.window.setStatusBarMessage(
                "Cloud.ru: сервер докачивается в фоне — следующее подключение будет быстрее",
                10_000,
              );
              break;
            default:
              logger.info(`[preseed] ${result.status}`);
          }
        } finally {
          subscription.dispose();
        }
      },
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      logger.info("[preseed] connection cancelled by user");
      cancelled = true;
    } else {
      logger.warn(`[preseed] failed (${errorMessage(err)}); Remote-SSH will install the server itself`);
    }
  } finally {
    connection.dispose();
  }
  return !cancelled;
}
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function ensureHostEntry(
  alias: string,
  entry: SshHostEntry,
  context: vscode.ExtensionContext,
  hostKeyLine: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const update = configUpdate.then(() => writeHostEntry(alias, entry, context, hostKeyLine, isCurrent));
  configUpdate = update.catch(() => undefined);
  return update;
}

async function writeHostEntry(
  alias: string,
  entry: SshHostEntry,
  context: vscode.ExtensionContext,
  hostKeyLine: string,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return;
  const sshDir = path.join(os.homedir(), ".ssh");
  await fs.mkdir(sshDir, { recursive: true });
  const configPath = path.join(sshDir, "config");

  const knownHosts = path.join(context.globalStorageUri.fsPath, "known_hosts");
  await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });

  let oldHosts = "";
  try {
    oldHosts = await fs.readFile(knownHosts, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const hostId = hostKeyLine.split(" ", 1)[0];
  const nextHosts = `${oldHosts.split("\n").filter((line) => line && !line.startsWith(`${hostId} `)).join("\n")}\n${hostKeyLine}\n`.replace(/^\n/, "");
  await writeIfUnchanged(knownHosts, oldHosts, nextHosts, isCurrent);

  let existing = "";
  try {
    existing = await fs.readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (!isCurrent()) return;
  const next = upsertSshConfigBlock(existing, alias, formatHostStanza(alias, entry, knownHosts));
  await writeIfUnchanged(configPath, existing, next, isCurrent);
}

async function writeIfUnchanged(filePath: string, existing: string, next: string, isCurrent: () => boolean): Promise<void> {
  try {
    if ((await fs.lstat(filePath)).isSymbolicLink()) throw new Error(`Refusing to replace symbolic link ${filePath}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.cloudru-${randomUUID()}`);
  try {
    await fs.writeFile(tempPath, next, { mode: 0o600, flag: "wx" });
    let current = "";
    try {
      current = await fs.readFile(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (current !== existing) throw new Error(`${filePath} changed during update; please retry`);
    try {
      if ((await fs.lstat(filePath)).isSymbolicLink()) throw new Error(`Refusing to replace symbolic link ${filePath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (!isCurrent()) return;
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.unlink(tempPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
  }
}
