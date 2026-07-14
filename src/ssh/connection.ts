import * as net from "node:net";
import { Client } from "ssh2";
import type { ConnectConfig, SFTPWrapper } from "ssh2";

export interface SshConnectionConfig {
  host: string;
  port: number;
  username: string;
  privateKey: Buffer;
  passphrase?: string;
}
export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * One SSH client to a notebook's gateway, shared by the SFTP file browser and the local port forward
 * used to reach the pod's Jupyter kernel. Connects lazily and clears its cached promises on close so
 * the next use reconnects. Offers `ssh-rsa` for the older keys cloud.ru issues.
 */
export class SshConnection {
  private clientPromise: Promise<Client> | undefined;
  private sftpPromise: Promise<SFTPWrapper> | undefined;
  private readonly forwardServers: net.Server[] = [];

  constructor(private readonly config: SshConnectionConfig) {}

  /** Returns a ready SFTP channel, connecting on demand. */
  async sftp(): Promise<SFTPWrapper> {
    if (!this.sftpPromise) {
      this.sftpPromise = this.openSftp().catch((err) => {
        this.sftpPromise = undefined;
        throw err;
      });
    }
    return this.sftpPromise;
  }

  /**
   * Open a local TCP forward (`ssh -L`) to `remoteHost:remotePort` on the pod and return the local
   * port. Used to reach the pod's tokenless JupyterLab (127.0.0.1:8888) directly, bypassing the proxy.
   * `onError` surfaces per-connection/channel failures (e.g. WebSocket) for diagnostics.
   */
  async forward(remoteHost: string, remotePort: number, onError?: (error: Error) => void): Promise<number> {
    const client = await this.getClient();
    const server = net.createServer((socket) => {
      socket.on("error", (err) => onError?.(err));
      const srcPort = socket.remotePort ?? 0;
      client.forwardOut(socket.remoteAddress ?? "127.0.0.1", srcPort, remoteHost, remotePort, (err, stream) => {
        if (err) {
          onError?.(err);
          socket.destroy();
          return;
        }
        stream.on("error", (streamErr: Error) => onError?.(streamErr));
        socket.pipe(stream);
        stream.pipe(socket);
        socket.on("close", () => stream.end());
        stream.on("close", () => socket.destroy());
      });
    });
    this.forwardServers.push(server);

    const { promise, resolve, reject } = Promise.withResolvers<number>();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
    return promise;
  }
  /**
   * Run a command on the pod and collect its output. `stdin` (when given) is written to the remote
   * process and closed — used to feed whole scripts to `sh -s` without shell-quoting them.
   */
  async exec(command: string, stdin?: string): Promise<ExecResult> {
    const client = await this.getClient();
    const { promise, resolve, reject } = Promise.withResolvers<ExecResult>();
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      let stdout = "";
      let stderr = "";
      stream.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      stream.on("error", reject);
      stream.on("close", (code: number | null) => resolve({ code, stdout, stderr }));
      if (stdin !== undefined) stream.end(stdin);
    });
    return promise;
  }

  private async getClient(): Promise<Client> {
    if (!this.clientPromise) {
      this.clientPromise = this.connect().catch((err) => {
        this.clientPromise = undefined;
        throw err;
      });
    }
    return this.clientPromise;
  }

  private async connect(): Promise<Client> {
    const client = new Client();
    const ready = Promise.withResolvers<void>();
    client.once("ready", () => ready.resolve());
    client.once("error", (err) => ready.reject(err));
    client.once("close", () => {
      this.clientPromise = undefined;
      this.sftpPromise = undefined;
    });

    const connectConfig: ConnectConfig = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      privateKey: this.config.privateKey,
      readyTimeout: 30_000,
      keepaliveInterval: 20_000,
      algorithms: {
        serverHostKey: ["ssh-ed25519", "ecdsa-sha2-nistp256", "rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"],
      },
      // The gateway host key is fixed and routing is by username; accept it (TOFU could be added later).
      hostVerifier: () => true,
    };
    if (this.config.passphrase) connectConfig.passphrase = this.config.passphrase;

    client.connect(connectConfig);
    await ready.promise;
    return client;
  }

  private async openSftp(): Promise<SFTPWrapper> {
    const client = await this.getClient();
    const sftpReady = Promise.withResolvers<SFTPWrapper>();
    client.sftp((err, sftp) => (err ? sftpReady.reject(err) : sftpReady.resolve(sftp)));
    return sftpReady.promise;
  }

  dispose(): void {
    for (const server of this.forwardServers) server.close();
    this.forwardServers.length = 0;
    void this.clientPromise?.then((client) => client.end()).catch(() => undefined);
    this.clientPromise = undefined;
    this.sftpPromise = undefined;
  }
}
