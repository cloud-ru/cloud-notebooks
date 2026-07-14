import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { NotebookHandlerResponse } from "../api/types";
import type { Logger } from "../util/logger";
import type { SshConfig } from "./sshConfig";
import { SshConnection } from "./connection";
import { formatHostStanza, type SshHostEntry, upsertSshConfigBlock } from "./sshConfigFile";
import { parseProductJson, preseedServer, type ProductInfo } from "./serverPreseed";

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
    void vscode.window.showErrorMessage(`Could not write SSH config: ${errorMessage(err)}`);
    return;
  }
  // Pods have throttled egress to the VS Code CDN, so Remote-SSH's own on-pod server download can
  // take many minutes. Pre-seed the matching server over our (fast) SSH gateway first; on any
  // failure or cancellation just proceed — Remote-SSH will fall back to its own installer.
  await preseedVsCodeServer(entry, context, logger);

  const uri = vscode.Uri.parse(`vscode-remote://ssh-remote+${alias}${REMOTE_HOME}`);
  logger.info(`Opening full IDE for ${notebook.name} → ${uri.toString()}`);
  await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: true });
}
/** Best-effort server pre-seed with a cancellable progress notification. Never throws. */
async function preseedVsCodeServer(
  entry: SshHostEntry,
  context: vscode.ExtensionContext,
  logger: Logger,
): Promise<void> {
  let product: ProductInfo | undefined;
  try {
    product = parseProductJson(await fs.readFile(path.join(vscode.env.appRoot, "product.json"), "utf8"));
  } catch (err) {
    logger.warn(`[preseed] cannot read product.json: ${errorMessage(err)}`);
    return;
  }
  if (!product) {
    logger.info("[preseed] client product is not pre-seedable (no commit or unknown update endpoint); skipping");
    return;
  }

  let privateKey: Buffer;
  try {
    privateKey = await fs.readFile(entry.identityFile);
  } catch (err) {
    logger.warn(`[preseed] cannot read key ${entry.identityFile}: ${errorMessage(err)}`);
    return;
  }

  const connection = new SshConnection({
    host: entry.host,
    port: entry.port,
    username: entry.username,
    privateKey,
  });
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Cloud.ru: подготовка VS Code Server на ноутбуке…",
        cancellable: true,
      },
      async (progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        let lastPercent = 0;
        const result = await preseedServer({
          product,
          exec: (command, stdin) => connection.exec(command, stdin),
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
            logger.info("[preseed] slow download continues in background; the server will be pre-seeded on a later connect");
            void vscode.window.setStatusBarMessage(
              "Cloud.ru: сервер докачивается в фоне — следующее подключение будет быстрее",
              10_000,
            );
            break;
          default:
            logger.info(`[preseed] ${result.status}`);
        }
      },
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      logger.info("[preseed] cancelled by user; Remote-SSH will install the server itself");
    } else {
      logger.warn(`[preseed] failed (${errorMessage(err)}); Remote-SSH will install the server itself`);
    }
  } finally {
    connection.dispose();
  }
}
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
