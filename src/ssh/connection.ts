import * as net from "node:net";
import { Client } from "ssh2";
import type { ConnectConfig, SFTPWrapper, VerifyCallback } from "ssh2";

export interface SshConnectionConfig {
  host: string;
  port: number;
  username: string;
  privateKey: Buffer;
  passphrase?: string;
  verifyHostKey?: (key: Buffer) => Promise<boolean>;
}
export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
/** Default bound for one remote command; long jobs (e.g. unpacking the server tarball) pass their own. */
const EXEC_DEADLINE_MS = 120_000;

/**
 * One SSH client to a notebook's gateway, shared by the SFTP file browser and the local port forward
 * used to reach the pod's Jupyter kernel. Connects lazily and clears its cached promises on close so
 * the next use reconnects. Offers `ssh-rsa` for the older keys cloud.ru issues.
 */
export class SshConnection {
  private clientPromise: Promise<Client> | undefined;
  private sftpPromise: Promise<SFTPWrapper> | undefined;
  private connectingClient: Client | undefined;
  private rejectConnect: ((error: Error) => void) | undefined;
  private disposed = false;
  private readonly forwardServers: net.Server[] = [];
  /** Live tunnel sockets per forward server, destroyed on dispose (kernel sockets are long-lived). */
  private readonly forwardSockets = new Map<net.Server, Set<net.Socket>>();
  /** Forwards still waiting for their listen callback; dispose() must reject them or they hang forever. */
  private readonly pendingForwards = new Map<net.Server, (error: Error) => void>();

  constructor(private readonly config: SshConnectionConfig) {}

  /** Returns a ready SFTP channel, connecting on demand. */
  async sftp(): Promise<SFTPWrapper> {
    if (this.disposed) throw new Error("SSH connection was closed");
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
    if (this.disposed) throw new Error("SSH connection was closed");
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
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
    this.forwardSockets.set(server, sockets);
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    const settle = (complete: () => void) => {
      this.pendingForwards.delete(server);
      complete();
    };
    this.pendingForwards.set(server, reject);
    server.once("error", (err) => settle(() => reject(err)));
    server.listen(0, "127.0.0.1", () => settle(() => resolve((server.address() as net.AddressInfo).port)));
    return promise;
  }
  /**
   * Run a command on the pod and collect its output. `stdin` (when given) is written to the remote
   * process and closed — used to feed whole scripts to `sh -s` without shell-quoting them.
   */
  async exec(command: string, stdin?: string, signal?: AbortSignal, deadlineMs = EXEC_DEADLINE_MS): Promise<ExecResult> {
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const connecting = this.getClient();
    const client = signal ? await new Promise<Client>((resolve, reject) => {
      const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(new DOMException("The operation was aborted.", "AbortError")); };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      connecting.then(
        (ready) => { signal.removeEventListener("abort", onAbort); resolve(ready); },
        (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
      );
    }) : await connecting;
    if (this.disposed) throw new Error("SSH connection was closed");
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const { promise, resolve, reject } = Promise.withResolvers<ExecResult>();
    let settled = false;
    let activeStream: { destroy: () => void } | undefined;
    const finish = (error?: Error, result?: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const abort = () => {
      finish(new DOMException("The operation was aborted.", "AbortError"));
      activeStream?.destroy();
    };
    const deadline = setTimeout(() => {
      finish(new Error(`SSH command exceeded ${deadlineMs} ms`));
      activeStream?.destroy();
    }, deadlineMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (settled) return promise;
    try {
      client.exec(command, (err, stream) => {
      if (settled) {
        stream?.on("error", () => undefined);
        stream?.destroy();
        return;
      }
      if (err) {
        finish(err);
        return;
      }
      activeStream = stream;
      let stdout = "";
      let stderr = "";
      stream.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      stream.on("error", (error: Error) => finish(error));
      stream.on("close", (code: number | null) => finish(undefined, { code, stdout, stderr }));
      if (stdin !== undefined) stream.end(stdin);
      });
    } catch (err) {
      finish(err as Error);
    }
    return promise;
  }

  private async getClient(): Promise<Client> {
    if (this.disposed) throw new Error("SSH connection was closed");
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
    this.connectingClient = client;
    const ready = Promise.withResolvers<void>();
    this.rejectConnect = ready.reject;
    client.once("ready", () => ready.resolve());
    client.once("error", (err) => ready.reject(err));
    client.once("close", () => {
      ready.reject(new Error("SSH connection closed before it was ready"));
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
      hostVerifier: (key: Buffer, verify: VerifyCallback) => {
        void Promise.resolve().then(() => this.config.verifyHostKey?.(key) ?? false)
          .then((trusted) => verify(trusted))
          .catch(() => verify(false));
      },
    };
    if (this.config.passphrase) connectConfig.passphrase = this.config.passphrase;

    client.connect(connectConfig);
    try {
      await ready.promise;
    } catch (error) {
      client.destroy();
      throw error;
    } finally {
      if (this.connectingClient === client) this.connectingClient = undefined;
      this.rejectConnect = undefined;
    }
    if (this.disposed) {
      client.destroy();
      throw new Error("SSH connection was closed");
    }
    return client;
  }

  private async openSftp(): Promise<SFTPWrapper> {
    const client = await this.getClient();
    if (this.disposed) throw new Error("SSH connection was closed");
    const sftpReady = Promise.withResolvers<SFTPWrapper>();
    client.sftp((err, sftp) => {
      if (this.disposed) {
        sftp?.end();
        sftpReady.reject(new Error("SSH connection was closed"));
      } else if (err) sftpReady.reject(err);
      else sftpReady.resolve(sftp);
    });
    return sftpReady.promise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectConnect?.(new Error("SSH connection was closed"));
    this.connectingClient?.destroy();
    // Live tunnel sockets keep plain server.close() waiting forever — destroy them first.
    for (const sockets of this.forwardSockets.values()) {
      for (const socket of sockets) socket.destroy();
    }
    this.forwardSockets.clear();
    // A server closed before its listen callback never fires it — reject waiters here instead.
    for (const reject of this.pendingForwards.values()) reject(new Error("SSH connection was closed"));
    this.pendingForwards.clear();
    for (const server of this.forwardServers) server.close();
    this.forwardServers.length = 0;
    void this.clientPromise?.then((client) => client.destroy()).catch(() => undefined);
    this.clientPromise = undefined;
    this.sftpPromise = undefined;
  }
}
