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
  private readonly forwards = new Map<string, { connection: SshConnection; baseUrl: string }>();

  constructor(private readonly deps: CloudruServerProviderDeps) {}

  refresh(): void {
    this.didChange.fire();
  }

  async provideJupyterServers(): Promise<JupyterServer[]> {
    try {
      const running = (await this.deps.getRunningNotebooks()).filter((nb) => nb.status === "running" && nb.url);
      this.notebooks.clear();
      for (const nb of running) this.notebooks.set(nb.uid, nb);
      return running.map((nb) => ({ id: nb.uid, label: nb.name }));
    } catch (err) {
      this.deps.logger.error("provideJupyterServers failed", err);
      return [];
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
    if (existing) return existing.baseUrl;

    const notebook = this.notebooks.get(uid);
    if (!notebook?.url) {
      throw new Error("Notebook is no longer available — refresh the Cloud.ru notebooks list.");
    }

    const target = await this.deps.config.resolveTarget(notebook);
    if (!target) throw new Error("SSH is not configured (private key / account id).");

    const connection = new SshConnection(target);
    const localPort = await connection.forward("127.0.0.1", POD_JUPYTER_PORT);
    const baseUrl = buildKernelBaseUrl(localPort, parseNotebookUrl(notebook.url).prefix);
    this.forwards.set(uid, { connection, baseUrl });
    this.deps.logger.info(`Kernel tunnel for ${notebook.name}: ${baseUrl}`);
    return baseUrl;
  }

  dispose(): void {
    for (const { connection } of this.forwards.values()) connection.dispose();
    this.forwards.clear();
    this.didChange.dispose();
  }
}
