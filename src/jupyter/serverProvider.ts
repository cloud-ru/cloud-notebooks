import * as vscode from "vscode";
import type {
  JupyterServer,
  JupyterServerConnectionInformation,
  JupyterServerProvider,
} from "@vscode/jupyter-extension";
import type { NotebookHandlerResponse } from "../api/types";
import type { Logger } from "../util/logger";
import { SshConnection } from "../ssh/connection";
import type { SshConfig } from "../ssh/sshConfig";
import { buildKernelBaseUrl } from "./kernelUrl";
import { parseNotebookUrl } from "./notebookUrl";
import { probeHttpAlive } from "./httpProbe";
import { NotSignedInError } from "../console/tokenProvider";

const POD_JUPYTER_PORT = 8888;

export interface CloudruServerProviderDeps {
  config: SshConfig;
  getRunningNotebooks: () => Promise<NotebookHandlerResponse[]>;
  logger: Logger;
}

/**
 * Contributes the running notebooks to the VS Code Jupyter extension as remote Jupyter servers. Each
 * resolves to a local SSH port-forward (`127.0.0.1:<port> → pod:8888`) onto the pod's tokenless
 * JupyterLab, so cells execute on the cloud kernel (Colab-style) — bypassing the OIDC proxy.
 */
export class CloudruServerProvider implements JupyterServerProvider {
  private readonly didChange = new vscode.EventEmitter<void>();
  readonly onDidChangeServers = this.didChange.event;
  private readonly notebooks = new Map<string, NotebookHandlerResponse>();
  // Each forward remembers the notebook URL it was built for; a pause→resume changes the URL (or drops
  // the notebook), so a stale forward is disposed rather than handed back to a dead pod.
  private readonly forwards = new Map<string, { connection: SshConnection; baseUrl: string; url: string }>();

  constructor(private readonly deps: CloudruServerProviderDeps) {}

  refresh(): void {
    this.didChange.fire();
  }

  async provideJupyterServers(): Promise<JupyterServer[]> {
    try {
      const running = (await this.deps.getRunningNotebooks()).filter((nb) => nb.status === "running" && nb.url);
      this.notebooks.clear();
      for (const nb of running) this.notebooks.set(nb.uid, nb);
      this.pruneStaleForwards();
      return running.map((nb) => ({ id: nb.uid, label: nb.name }));
    } catch (err) {
      if (err instanceof NotSignedInError) {
        this.deps.logger.info("provideJupyterServers: Cloud.ru session expired; prompting re-auth.");
        return [];
      }
      this.deps.logger.error("provideJupyterServers failed", err);
      return [];
    }
  }

  /** Drop forwards whose notebook is gone, no longer running, or was recreated under a new URL. */
  private pruneStaleForwards(): void {
    for (const [uid, fwd] of this.forwards) {
      const nb = this.notebooks.get(uid);
      if (!nb || nb.url !== fwd.url) {
        this.deps.logger.info(`Disposing stale kernel tunnel for ${uid} (notebook changed/removed).`);
        fwd.connection.dispose();
        this.forwards.delete(uid);
      }
    }
  }

  async resolveJupyterServer(server: JupyterServer): Promise<JupyterServer> {
    const baseUrl = await this.ensureForward(server.id);
    const connectionInformation: JupyterServerConnectionInformation = {
      baseUrl: vscode.Uri.parse(baseUrl),
      token: "",
    };
    return { ...server, connectionInformation };
  }

  private async ensureForward(uid: string): Promise<string> {
    const existing = this.forwards.get(uid);
    if (existing) {
      if (await probeHttpAlive(existing.baseUrl, { acceptAny: true })) return existing.baseUrl;
      this.deps.logger.info(`Kernel tunnel for ${uid} is unresponsive; rebuilding.`);
      existing.connection.dispose();
      this.forwards.delete(uid);
    }

    const notebook = this.notebooks.get(uid);
    if (!notebook?.url) {
      throw new Error("Notebook is no longer available — refresh the Cloud.ru notebooks list.");
    }

    // The kernel picker must never open dialogs — resolve non-interactively and fail clearly.
    const target = await this.deps.config.resolveTarget(notebook, { interactive: false });
    if (!target) throw new Error("SSH не настроен. Выполните команду «Cloud.ru: Настроить SSH».");

    const connection = new SshConnection(target);
    const localPort = await connection.forward("127.0.0.1", POD_JUPYTER_PORT, (err) =>
      this.deps.logger.error(`Kernel tunnel error for ${notebook.name}`, err),
    );
    const baseUrl = buildKernelBaseUrl(localPort, parseNotebookUrl(notebook.url).prefix);
    this.forwards.set(uid, { connection, baseUrl, url: notebook.url });
    this.deps.logger.info(`Kernel tunnel for ${notebook.name}: ${baseUrl}`);
    return baseUrl;
  }

  /** Drop the cached forward for a uid (after a pause/resume) so the next connect rebuilds it. */
  invalidate(uid: string): void {
    const fwd = this.forwards.get(uid);
    if (!fwd) return;
    fwd.connection.dispose();
    this.forwards.delete(uid);
  }

  /** Tear down every forward (sign-out / workspace switch). */
  disposeAll(): void {
    for (const { connection } of this.forwards.values()) connection.dispose();
    this.forwards.clear();
  }

  dispose(): void {
    for (const { connection } of this.forwards.values()) connection.dispose();
    this.forwards.clear();
    this.didChange.dispose();
  }
}
