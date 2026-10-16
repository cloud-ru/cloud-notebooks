import * as http from "node:http";
import * as vscode from "vscode";
import type { NotebookHandlerResponse } from "../api/types";
import type { Logger } from "../util/logger";
import { SshConnection } from "../ssh/connection";
import type { SshConfig } from "../ssh/sshConfig";
import { labPath, parseNotebookUrl } from "./notebookUrl";
import { openNotebookPanel } from "./notebookPanel";
import { NotebookShim } from "./shim";
import { probeHttpAlive } from "./httpProbe";

const POD_JUPYTER_PORT = 8888;

/**
 * "Open the notebook UI inside VS Code": tunnel to the pod's tokenless JupyterLab (127.0.0.1:8888)
 * over SSH — the same proven path the remote kernel uses — and frame it in a webview through a local
 * shim that strips X-Frame-Options / CSP frame-ancestors. No OIDC proxy, no cookie capture.
 */
export class NotebookViewController {
  private readonly connections = new Map<string, SshConnection>(); // by notebook uid
  private readonly shims = new Map<string, { shim: NotebookShim; appPath: string }>(); // by uid
  private readonly panels = new Map<string, vscode.WebviewPanel>(); // by notebook uid
  private readonly inFlightShims = new Map<string, Promise<{ shim: NotebookShim; appPath: string } | undefined>>();
  private readonly inFlightOpens = new Map<string, Promise<void>>();
  private readonly versions = new Map<string, number>();
  private generation = 0;
  private disposed = false;

  constructor(private readonly deps: { config: SshConfig; logger: Logger }) {}

  async open(notebook: NotebookHandlerResponse): Promise<void> {
    if (this.disposed) throw new Error("Notebook controller was closed");
    const pending = this.inFlightOpens.get(notebook.uid);
    if (pending) return pending;
    const generation = this.generation;
    const version = this.versions.get(notebook.uid) ?? 0;
    const opening = this.openPanel(notebook, generation, version).finally(() => {
      if (this.inFlightOpens.get(notebook.uid) === opening) this.inFlightOpens.delete(notebook.uid);
    });
    this.inFlightOpens.set(notebook.uid, opening);
    return opening;
  }

  private async openPanel(notebook: NotebookHandlerResponse, generation: number, version: number): Promise<void> {
    if (notebook.status !== "running" || !notebook.url) {
      void vscode.window.showWarningMessage(
        `«${notebook.name}»: ${notebook.status}. Ноутбук должен быть запущен, чтобы открыть его.`,
      );
      return;
    }
    const entry = await this.ensureShim(notebook);
    if (!entry || !this.isCurrent(notebook.uid, generation, version)) return;

    const localUrl = `${entry.shim.baseUrl}${entry.appPath}`;
    // asExternalUri: the sanctioned way to frame a local server in a webview (works in forks/remote).
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(localUrl));
    if (!this.isCurrent(notebook.uid, generation, version)) return;
    this.deps.logger.info(`Opening notebook webview: shim=${entry.shim.baseUrl} frame=${external.toString()}`);

    const panel = openNotebookPanel({
      title: notebook.name,
      frameSrc: external.toString(),
      frameOrigin: `${external.scheme}://${external.authority}`,
      existing: this.panels.get(notebook.uid),
      onRetry: () => {
        this.invalidate(notebook.uid);
        void this.open(notebook).catch((err) => this.deps.logger.error(`Notebook retry failed for ${notebook.name}`, err));
      },
      onShowOutput: () => this.deps.logger.show(),
    });
    this.panels.set(notebook.uid, panel);
    panel.onDidDispose(() => {
      if (this.panels.get(notebook.uid) === panel) this.panels.delete(notebook.uid);
    });
  }

  private async ensureShim(
    notebook: NotebookHandlerResponse,
  ): Promise<{ shim: NotebookShim; appPath: string } | undefined> {
    const pending = this.inFlightShims.get(notebook.uid);
    if (pending) return pending;
    const generation = this.generation;
    const version = this.versions.get(notebook.uid) ?? 0;
    const creating = this.createShim(notebook, generation, version).finally(() => {
      if (this.inFlightShims.get(notebook.uid) === creating) this.inFlightShims.delete(notebook.uid);
    });
    this.inFlightShims.set(notebook.uid, creating);
    return creating;
  }

  private isCurrent(uid: string, generation: number, version: number): boolean {
    return !this.disposed && generation === this.generation && version === (this.versions.get(uid) ?? 0);
  }

  private async createShim(
    notebook: NotebookHandlerResponse, generation: number, version: number,
  ): Promise<{ shim: NotebookShim; appPath: string } | undefined> {
    const existing = this.shims.get(notebook.uid);
    if (existing) {
      // Reuse only if the shim still reaches a live pod; a pause→resume leaves it wired to a dead
      // tunnel, which otherwise renders as a webview that spins forever.
      if (await probeHttpAlive(`${existing.shim.baseUrl}${existing.appPath}`)) {
        return this.isCurrent(notebook.uid, generation, version) ? existing : undefined;
      }
      if (!this.isCurrent(notebook.uid, generation, version)) return undefined;
      this.deps.logger.info(`Notebook shim for ${notebook.name} is stale; rebuilding.`);
      existing.shim.dispose();
      this.connections.get(notebook.uid)?.dispose();
      this.shims.delete(notebook.uid);
      this.connections.delete(notebook.uid);
    }
    const target = await this.deps.config.resolveTarget(notebook);
    if (!target || !this.isCurrent(notebook.uid, generation, version)) return undefined;
    const connection = this.connections.get(notebook.uid) ?? new SshConnection(target);
    this.connections.set(notebook.uid, connection);
    try {
      const { prefix } = parseNotebookUrl(notebook.url ?? "");
      const localPort = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Подключение к «${notebook.name}»…` },
        () =>
          connection.forward("127.0.0.1", POD_JUPYTER_PORT, (err) =>
            {
              this.deps.logger.error(`Notebook tunnel error for ${notebook.name}`, err);
              void this.panels.get(notebook.uid)?.webview.postMessage({ type: "disconnected" });
            },
          ),
      );
      if (!this.isCurrent(notebook.uid, generation, version)) {
        connection.dispose();
        return undefined;
      }
      // Jupyter serves its UI under base_url=<prefix> (".../lab"); other app images (marimo, vscode, …)
      // serve from "/". Probe the pod to pick the path that actually returns a UI — no per-type guessing.
      const appPath = await this.probeAppPath(localPort, [labPath(prefix), "/"]);
      if (!this.isCurrent(notebook.uid, generation, version)) {
        connection.dispose();
        return undefined;
      }
      const shim = new NotebookShim({
        origin: `http://127.0.0.1:${localPort}`,
        onError: (err) => {
          this.deps.logger.error(`Notebook shim error for ${notebook.name}`, err);
          void this.panels.get(notebook.uid)?.webview.postMessage({ type: "disconnected" });
        },
        onTrace: (method, url, status) => this.deps.logger.info(`shim ${status} ${method} ${url}`),
      });
      await shim.start();
      if (!this.isCurrent(notebook.uid, generation, version)) {
        shim.dispose();
        connection.dispose();
        return undefined;
      }
      const entry = { shim, appPath };
      this.shims.set(notebook.uid, entry);
      return entry;
    } catch (err) {
      connection.dispose();
      if (this.connections.get(notebook.uid) === connection) this.connections.delete(notebook.uid);
      if (!this.isCurrent(notebook.uid, generation, version)) return undefined;
      this.deps.logger.error(`Notebook connect failed for ${notebook.name}`, err);
      void vscode.window.showErrorMessage(`Не удалось подключиться к «${notebook.name}»: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Pick the first candidate path that returns a usable HTTP response (2xx/3xx) from the pod. */
  private async probeAppPath(localPort: number, candidates: string[]): Promise<string> {
    for (const path of candidates) {
      if (await probeHttp(localPort, path)) {
        this.deps.logger.info(`Notebook app path resolved to "${path}"`);
        return path;
      }
    }
    throw new Error("Приложение не ответило ни по одному доступному адресу. Проверьте статус ноутбука и повторите подключение.");
  }

  /** Drop cached shim/connection/panel for a uid (after a pause/resume) so the next open rebuilds. */
  invalidate(uid: string): void {
    this.versions.set(uid, (this.versions.get(uid) ?? 0) + 1);
    this.inFlightShims.delete(uid);
    this.inFlightOpens.delete(uid);
    this.shims.get(uid)?.shim.dispose();
    this.connections.get(uid)?.dispose();
    this.panels.get(uid)?.dispose();
    this.shims.delete(uid);
    this.connections.delete(uid);
    this.panels.delete(uid);
  }

  /** Tear down everything (sign-out / workspace switch). */
  disposeAll(): void {
    this.generation++;
    for (const { shim } of this.shims.values()) shim.dispose();
    for (const connection of this.connections.values()) connection.dispose();
    for (const panel of this.panels.values()) panel.dispose();
    this.shims.clear();
    this.connections.clear();
    this.panels.clear();
    this.inFlightShims.clear();
    this.inFlightOpens.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.disposeAll();
  }
}

/** GET the path through the local tunnel; true if the pod returns a usable HTTP response (2xx/3xx). */
function probeHttp(localPort: number, path: string, timeoutMs = 6000): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const req = http.get({ host: "127.0.0.1", port: localPort, path, timeout: timeoutMs }, (res) => {
    const status = res.statusCode ?? 0;
    res.resume(); // drain
    resolve(status >= 200 && status < 400);
  });
  req.on("error", () => resolve(false)); // parse error / connection reset → not this path
  req.on("timeout", () => {
    req.destroy();
    resolve(false);
  });
  return promise;
}
