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
  private readonly inFlightForwards = new Map<string, Promise<string>>();
  private readonly versions = new Map<string, number>();
  private generation = 0;
  private disposed = false;

  constructor(private readonly deps: CloudruServerProviderDeps) {}

  refresh(): void {
    this.didChange.fire();
  }

  async provideJupyterServers(): Promise<JupyterServer[]> {
    const generation = this.generation;
    try {
      const running = (await this.deps.getRunningNotebooks()).filter((nb) => nb.status === "running" && nb.url);
      if (this.disposed || generation !== this.generation) return [];
      this.notebooks.clear();
      for (const nb of running) this.notebooks.set(nb.uid, nb);
      this.pruneStaleForwards();
      return running.map((nb) => ({ id: nb.uid, label: nb.name }));
    } catch (err) {
      if (this.disposed || generation !== this.generation) return [];
      if (err instanceof NotSignedInError) {
        this.deps.logger.info("provideJupyterServers: Cloud.ru session expired; prompting re-auth.");
        throw err;
      }
      this.deps.logger.error("provideJupyterServers failed", err);
      throw err;
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
    if (this.disposed) throw new Error("Kernel server provider was closed");
    const pending = this.inFlightForwards.get(uid);
    if (pending) return pending;
    const generation = this.generation;
    const version = this.versions.get(uid) ?? 0;
    const creating = this.createForward(uid, generation, version).finally(() => {
      if (this.inFlightForwards.get(uid) === creating) this.inFlightForwards.delete(uid);
    });
    this.inFlightForwards.set(uid, creating);
    return creating;
  }

  private isCurrent(uid: string, generation: number, version: number): boolean {
    return !this.disposed && generation === this.generation && version === (this.versions.get(uid) ?? 0);
  }

  private async createForward(uid: string, generation: number, version: number): Promise<string> {
    const existing = this.forwards.get(uid);
    if (existing) {
      if (await probeHttpAlive(existing.baseUrl, { acceptAny: true })) {
        if (!this.isCurrent(uid, generation, version)) throw new Error("Kernel context changed");
        return existing.baseUrl;
      }
      if (!this.isCurrent(uid, generation, version)) throw new Error("Kernel context changed");
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
    if (!this.isCurrent(uid, generation, version)) throw new Error("Kernel context changed");

    const connection = new SshConnection(target);
    try {
      const localPort = await connection.forward("127.0.0.1", POD_JUPYTER_PORT, (err) =>
        this.deps.logger.error(`Kernel tunnel error for ${notebook.name}`, err),
      );
      if (!this.isCurrent(uid, generation, version) || this.notebooks.get(uid)?.url !== notebook.url) {
        throw new Error("Kernel context changed");
      }
      const baseUrl = buildKernelBaseUrl(localPort, parseNotebookUrl(notebook.url).prefix);
      this.forwards.set(uid, { connection, baseUrl, url: notebook.url });
      this.deps.logger.info(`Kernel tunnel for ${notebook.name}: ${baseUrl}`);
      return baseUrl;
    } catch (error) {
      connection.dispose();
      throw error;
    }
  }

  /** Drop the cached forward for a uid (after a pause/resume) so the next connect rebuilds it. */
  invalidate(uid: string): void {
    this.versions.set(uid, (this.versions.get(uid) ?? 0) + 1);
    this.inFlightForwards.delete(uid);
    this.notebooks.delete(uid);
    const fwd = this.forwards.get(uid);
    if (!fwd) return;
    fwd.connection.dispose();
    this.forwards.delete(uid);
  }

  /** Tear down every forward (sign-out / workspace switch). */
  disposeAll(): void {
    this.generation++;
    for (const { connection } of this.forwards.values()) connection.dispose();
    this.forwards.clear();
    this.inFlightForwards.clear();
    this.notebooks.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.disposeAll();
    this.didChange.dispose();
  }
}
