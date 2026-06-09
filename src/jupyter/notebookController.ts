import * as fs from "node:fs";
import * as vscode from "vscode";
import type { NotebookHandlerResponse } from "../api/types";
import type { Logger } from "../util/logger";
import { findChrome } from "./chrome";
import { labPath, parseNotebookUrl } from "./notebookUrl";
import { openNotebookPanel } from "./notebookPanel";
import { captureNotebookSession } from "./oidcLogin";
import { NotebookSessionStore } from "./sessionCookies";
import { NotebookShim } from "./shim";

/**
 * Owns the moving parts for "open the notebook UI inside VS Code": the captured OIDC session, the
 * per-origin local shim, and the webview panels. One shim is shared per notebook origin; one panel
 * per notebook uid.
 */
export class NotebookViewController {
  private readonly sessions: NotebookSessionStore;
  private readonly shims = new Map<string, NotebookShim>(); // by origin
  private readonly cookies = new Map<string, string>(); // by host (in-memory mirror of the store)
  private readonly panels = new Map<string, vscode.WebviewPanel>(); // by notebook uid

  constructor(
    private readonly deps: {
      secrets: vscode.SecretStorage;
      context: vscode.ExtensionContext;
      logger: Logger;
    },
  ) {
    this.sessions = new NotebookSessionStore(deps.secrets);
  }

  async open(notebook: NotebookHandlerResponse): Promise<void> {
    if (notebook.status !== "running" || !notebook.url) {
      void vscode.window.showWarningMessage(
        `Notebook “${notebook.name}” is ${notebook.status}; it must be running before it can be opened.`,
      );
      return;
    }
    const { origin, prefix } = parseNotebookUrl(notebook.url);
    const host = new URL(origin).host;

    const cookie = await this.ensureSession(notebook.url, host);
    if (!cookie) return; // login cancelled or no browser available

    const shim = await this.ensureShim(origin, host);
    const panel = openNotebookPanel({
      title: notebook.name,
      iframeUrl: shim.baseUrl + labPath(prefix),
      existing: this.panels.get(notebook.uid),
    });
    this.panels.set(notebook.uid, panel);
    panel.onDidDispose(() => this.panels.delete(notebook.uid));
  }

  private async ensureSession(notebookUrl: string, host: string): Promise<string | undefined> {
    const cached = this.cookies.get(host) ?? (await this.sessions.get(host));
    if (cached) {
      this.cookies.set(host, cached);
      return cached;
    }
    return this.login(notebookUrl, host);
  }

  private async login(notebookUrl: string, host: string): Promise<string | undefined> {
    const override = vscode.workspace.getConfiguration("cloudru").get<string>("notebook.chromePath", "");
    const chromePath = findChrome(override);
    if (!chromePath) {
      void vscode.window.showErrorMessage(
        "No Chrome/Chromium found for sign-in. Set “cloudru.notebook.chromePath” to a browser executable.",
      );
      return undefined;
    }

    const userDataDir = vscode.Uri.joinPath(this.deps.context.globalStorageUri, "oidc-profile").fsPath;
    fs.mkdirSync(userDataDir, { recursive: true });

    try {
      const cookie = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Cloud.ru: complete sign-in in the opened browser window…",
        },
        () => captureNotebookSession({ notebookUrl, chromePath, userDataDir }),
      );
      this.cookies.set(host, cookie);
      await this.sessions.set(host, cookie);
      this.deps.logger.info(`Captured notebook session for ${host}.`);
      return cookie;
    } catch (err) {
      this.deps.logger.error("Notebook sign-in failed", err);
      void vscode.window.showErrorMessage(`Cloud.ru notebook sign-in failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async ensureShim(origin: string, host: string): Promise<NotebookShim> {
    const existing = this.shims.get(origin);
    if (existing) return existing;
    const tlsVerify = vscode.workspace.getConfiguration("cloudru").get<boolean>("notebook.tlsVerify", true);
    const shim = new NotebookShim({
      origin,
      getSessionCookie: () => this.cookies.get(host) ?? "",
      onAuthExpired: () => this.invalidate(host),
      onError: (err) => this.deps.logger.error(`Notebook proxy error for ${host}`, err),
      tlsVerify,
    });
    await shim.start();
    this.shims.set(origin, shim);
    return shim;
  }

  private invalidate(host: string): void {
    this.cookies.delete(host);
    void this.sessions.clear(host);
    void vscode.window.showWarningMessage(
      "Cloud.ru notebook session expired. Reopen the notebook to sign in again.",
    );
  }

  dispose(): void {
    for (const shim of this.shims.values()) shim.dispose();
    this.shims.clear();
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}
