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
import { NotebookShim } from "./shim";
import { createSshTunnelAgent } from "./sshAgent";
import { NotSignedInError } from "../console/tokenProvider";

const POD_JUPYTER_PORT = 8888;

export interface CloudruServerProviderDeps {
  config: SshConfig;
  getRunningNotebooks: () => Promise<NotebookHandlerResponse[]>;
  logger: Logger;
}

/** A notebook's kernel endpoint: the authenticated local shim and the SSH session behind it. */
interface KernelTunnel {
  connection: SshConnection;
  shim: NotebookShim;
  /** Jupyter base URL on the shim, e.g. `http://127.0.0.1:<port>/a100-mt/notebook/<uuid>/`. */
  baseUrl: string;
  /** Notebook URL the tunnel was built for. */
  url: string;
}

/**
 * Contributes the running notebooks to the VS Code Jupyter extension as remote Jupyter servers. Each
 * resolves to an authenticated local proxy (`NotebookShim` on `127.0.0.1:<port>`) that reaches the
 * pod's tokenless JupyterLab (pod:8888) over in-process SSH channels, so cells execute on the cloud
 * kernel (Colab-style) — bypassing the OIDC proxy. The shim's per-instance secret is the server token,
 * so no other local process can drive the kernel through it.
 */
export class CloudruServerProvider implements JupyterServerProvider {
  private readonly didChange = new vscode.EventEmitter<void>();
  readonly onDidChangeServers = this.didChange.event;
  private readonly notebooks = new Map<string, NotebookHandlerResponse>();
  // Each tunnel remembers the notebook URL it was built for; a pause→resume changes the URL (or drops
  // the notebook), so a stale tunnel is disposed rather than handed back to a dead pod.
  private readonly tunnels = new Map<string, KernelTunnel>();
  private readonly inFlightTunnels = new Map<string, Promise<KernelTunnel>>();
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
      this.pruneStaleTunnels();
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

  /** Drop tunnels whose notebook is gone, no longer running, or was recreated under a new URL. */
  private pruneStaleTunnels(): void {
    for (const [uid, tunnel] of this.tunnels) {
      const nb = this.notebooks.get(uid);
      if (!nb || nb.url !== tunnel.url) {
        this.deps.logger.info(`Disposing stale kernel tunnel for ${uid} (notebook changed/removed).`);
        disposeTunnel(tunnel);
        this.tunnels.delete(uid);
      }
    }
  }

  async resolveJupyterServer(server: JupyterServer): Promise<JupyterServer> {
    const { baseUrl, shim } = await this.ensureTunnel(server.id);
    const connectionInformation: JupyterServerConnectionInformation = {
      baseUrl: vscode.Uri.parse(baseUrl),
      // The Jupyter extension sends it as `Authorization: token …` (and `?token=` on WebSockets); the
      // shim checks and strips it, so the tokenless pod never sees it.
      token: shim.token,
    };
    return { ...server, connectionInformation };
  }

  private async ensureTunnel(uid: string): Promise<KernelTunnel> {
    if (this.disposed) throw new Error("Kernel server provider was closed");
    const pending = this.inFlightTunnels.get(uid);
    if (pending) return pending;
    const generation = this.generation;
    const version = this.versions.get(uid) ?? 0;
    const creating = this.createTunnel(uid, generation, version).finally(() => {
      if (this.inFlightTunnels.get(uid) === creating) this.inFlightTunnels.delete(uid);
    });
    this.inFlightTunnels.set(uid, creating);
    return creating;
  }

  private isCurrent(uid: string, generation: number, version: number): boolean {
    return !this.disposed && generation === this.generation && version === (this.versions.get(uid) ?? 0);
  }

  private async createTunnel(uid: string, generation: number, version: number): Promise<KernelTunnel> {
    const existing = this.tunnels.get(uid);
    if (existing) {
      if (await probeHttpAlive(existing.baseUrl, { headers: existing.shim.authHeaders })) {
        if (!this.isCurrent(uid, generation, version)) throw new Error("Kernel context changed");
        return existing;
      }
      if (!this.isCurrent(uid, generation, version)) throw new Error("Kernel context changed");
      this.deps.logger.info(`Kernel tunnel for ${uid} is unresponsive; rebuilding.`);
      disposeTunnel(existing);
      this.tunnels.delete(uid);
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
    let shim: NotebookShim | undefined;
    try {
      // Only the SSH handshake is awaited up front, so auth/host-key/network failures reject the kernel
      // picker with their own message instead of surfacing later as proxy errors.
      await connection.ready();
      if (!this.isCurrent(uid, generation, version) || this.notebooks.get(uid)?.url !== notebook.url) {
        throw new Error("Kernel context changed");
      }
      // No local port-forward: each proxied request rides its own in-process ssh2 channel, so the only
      // local listener is the shim, which rejects anything without its secret.
      const agent = createSshTunnelAgent(() => connection.openStream("127.0.0.1", POD_JUPYTER_PORT));
      shim = new NotebookShim({
        upstream: `http://127.0.0.1:${POD_JUPYTER_PORT}`,
        agent,
        onError: (err) => this.deps.logger.error(`Kernel proxy error for ${notebook.name}`, err),
      });
      const shimUrl = await shim.start();
      if (!this.isCurrent(uid, generation, version) || this.notebooks.get(uid)?.url !== notebook.url) {
        throw new Error("Kernel context changed");
      }
      const tunnel: KernelTunnel = {
        connection,
        shim,
        baseUrl: buildKernelBaseUrl(shimUrl, parseNotebookUrl(notebook.url).prefix),
        url: notebook.url,
      };
      this.tunnels.set(uid, tunnel);
      this.deps.logger.info(`Kernel tunnel for ${notebook.name}: ${tunnel.baseUrl}`);
      return tunnel;
    } catch (error) {
      shim?.dispose();
      connection.dispose();
      throw error;
    }
  }

  /** Drop the cached tunnel for a uid (after a pause/resume) so the next connect rebuilds it. */
  invalidate(uid: string): void {
    this.versions.set(uid, (this.versions.get(uid) ?? 0) + 1);
    this.inFlightTunnels.delete(uid);
    this.notebooks.delete(uid);
    const tunnel = this.tunnels.get(uid);
    if (!tunnel) return;
    disposeTunnel(tunnel);
    this.tunnels.delete(uid);
  }

  /** Tear down every tunnel (sign-out / workspace switch). */
  disposeAll(): void {
    this.generation++;
    for (const tunnel of this.tunnels.values()) disposeTunnel(tunnel);
    this.tunnels.clear();
    this.inFlightTunnels.clear();
    this.notebooks.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.disposeAll();
    this.didChange.dispose();
  }
}

/** Shim first, so no new local request reaches the SSH session while it is torn down. */
function disposeTunnel({ shim, connection }: KernelTunnel): void {
  shim.dispose();
  connection.dispose();
}
