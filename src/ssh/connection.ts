import { Client } from "ssh2";
import type { ClientChannel, ConnectConfig, SFTPWrapper, VerifyCallback } from "ssh2";

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
 * One SSH client to a notebook's gateway, shared by the SFTP file browser and the in-process
 * `direct-tcpip` channels that the local Jupyter proxies (`NotebookShim`) use to reach the pod.
 * Connects lazily and clears its cached promises on close so the next use reconnects. Offers
 * `ssh-rsa` for the older keys cloud.ru issues.
 */
export class SshConnection {
  private clientPromise: Promise<Client> | undefined;
  private sftpPromise: Promise<SFTPWrapper> | undefined;
  private connectingClient: Client | undefined;
  private rejectConnect: ((error: Error) => void) | undefined;
  private disposed = false;
  /** Channels handed out by openStream(); destroyed on dispose (kernel WebSockets are long-lived). */
  private readonly channels = new Set<ClientChannel>();

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

  /** Resolves once the SSH handshake completed (connects on demand); surfaces auth/host-key/network errors up front. */
  async ready(): Promise<void> {
    await this.getClient();
    if (this.disposed) throw new Error("SSH connection was closed");
  }

  /**
   * Open a `direct-tcpip` channel to `remoteHost:remotePort` on the pod. The channel stays in-process
   * (no local listener), so only callers holding this connection — the authenticated local proxies —
   * can reach the pod's tokenless JupyterLab.
   */
  async openStream(remoteHost: string, remotePort: number): Promise<ClientChannel> {
    const client = await this.getClient();
    if (this.disposed) throw new Error("SSH connection was closed");
    const { promise, resolve, reject } = Promise.withResolvers<ClientChannel>();
    client.forwardOut("127.0.0.1", 0, remoteHost, remotePort, (err, channel) => {
      if (err) {
        reject(err);
        return;
      }
      if (this.disposed) {
        channel.on("error", () => undefined);
        channel.destroy();
        reject(new Error("SSH connection was closed"));
        return;
      }
      this.channels.add(channel);
      channel.once("close", () => this.channels.delete(channel));
      resolve(channel);
    });
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
    for (const channel of this.channels) channel.destroy();
    this.channels.clear();
    void this.clientPromise?.then((client) => client.destroy()).catch(() => undefined);
    this.clientPromise = undefined;
    this.sftpPromise = undefined;
  }
}
