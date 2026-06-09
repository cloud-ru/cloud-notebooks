import * as vscode from "vscode";
import type { NotebookHandlerResponse } from "../api/types";
import type { Logger } from "../util/logger";
import { SshConnection } from "../ssh/connection";
import type { SshConfig } from "../ssh/sshConfig";
import { labPath, parseNotebookUrl } from "./notebookUrl";
import { openNotebookPanel } from "./notebookPanel";
import { NotebookShim } from "./shim";

const POD_JUPYTER_PORT = 8888;

/**
 * "Open the notebook UI inside VS Code": tunnel to the pod's tokenless JupyterLab (127.0.0.1:8888)
 * over SSH — the same proven path the remote kernel uses — and frame it in a webview through a local
 * shim that strips X-Frame-Options / CSP frame-ancestors. No OIDC proxy, no cookie capture.
 */
export class NotebookViewController {
  private readonly connections = new Map<string, SshConnection>(); // by notebook uid
  private readonly shims = new Map<string, NotebookShim>(); // by notebook uid
  private readonly panels = new Map<string, vscode.WebviewPanel>(); // by notebook uid

  constructor(private readonly deps: { config: SshConfig; logger: Logger }) {}

  async open(notebook: NotebookHandlerResponse): Promise<void> {
    if (notebook.status !== "running" || !notebook.url) {
      void vscode.window.showWarningMessage(
        `Notebook “${notebook.name}” is ${notebook.status}; it must be running before it can be opened.`,
      );
      return;
    }
    const { prefix } = parseNotebookUrl(notebook.url);

    const shim = await this.ensureShim(notebook);
    if (!shim) return;

    const localUrl = `${shim.baseUrl}${labPath(prefix)}`;
    // asExternalUri: the sanctioned way to frame a local server in a webview (works in forks/remote).
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(localUrl));
    this.deps.logger.info(`Opening notebook webview: shim=${shim.baseUrl} frame=${external.toString()}`);

    const panel = openNotebookPanel({
      title: notebook.name,
      frameSrc: external.toString(),
      frameOrigin: `${external.scheme}://${external.authority}`,
      existing: this.panels.get(notebook.uid),
    });
    this.panels.set(notebook.uid, panel);
    panel.onDidDispose(() => this.panels.delete(notebook.uid));
  }

  private async ensureShim(notebook: NotebookHandlerResponse): Promise<NotebookShim | undefined> {
    const existing = this.shims.get(notebook.uid);
    if (existing) return existing;

    const target = await this.deps.config.resolveTarget(notebook);
    if (!target) return undefined;

    const connection = this.connections.get(notebook.uid) ?? new SshConnection(target);
    this.connections.set(notebook.uid, connection);

    try {
      const localPort = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Connecting to ${notebook.name}…` },
        () =>
          connection.forward("127.0.0.1", POD_JUPYTER_PORT, (err) =>
            this.deps.logger.error(`Notebook tunnel error for ${notebook.name}`, err),
          ),
      );
      const shim = new NotebookShim({
        origin: `http://127.0.0.1:${localPort}`,
        getSessionCookie: () => "",
        onAuthExpired: () => undefined,
        onError: (err) => this.deps.logger.error(`Notebook shim error for ${notebook.name}`, err),
        onTrace: (method, url, status) => this.deps.logger.info(`shim ${status} ${method} ${url}`),
        tlsVerify: true,
      });
      await shim.start();
      this.shims.set(notebook.uid, shim);
      return shim;
    } catch (err) {
      this.deps.logger.error(`Notebook connect failed for ${notebook.name}`, err);
      void vscode.window.showErrorMessage(`Could not connect to ${notebook.name}: ${(err as Error).message}`);
      return undefined;
    }
  }

  dispose(): void {
    for (const shim of this.shims.values()) shim.dispose();
    for (const connection of this.connections.values()) connection.dispose();
    for (const panel of this.panels.values()) panel.dispose();
    this.shims.clear();
    this.connections.clear();
    this.panels.clear();
  }
}
