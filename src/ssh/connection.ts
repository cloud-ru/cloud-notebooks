import { Client } from "ssh2";
import type { ConnectConfig, SFTPWrapper } from "ssh2";

export interface SshConnectionConfig {
  host: string;
  port: number;
  username: string;
  privateKey: Buffer;
  passphrase?: string;
}

/**
 * One SSH client + SFTP channel to a notebook's gateway. Connects lazily on first use and reconnects
 * after a drop (the cached promise is cleared on close/error). Offers `ssh-rsa` for the older keys
 * cloud.ru issues, and accepts the gateway host key (the username routes to the pod).
 */
export class SshConnection {
  private client: Client | undefined;
  private sftpPromise: Promise<SFTPWrapper> | undefined;

  constructor(private readonly config: SshConnectionConfig) {}

  /** Returns a ready SFTP channel, connecting on demand. */
  async sftp(): Promise<SFTPWrapper> {
    if (!this.sftpPromise) {
      this.sftpPromise = this.open().catch((err) => {
        this.sftpPromise = undefined;
        throw err;
      });
    }
    return this.sftpPromise;
  }

  private async open(): Promise<SFTPWrapper> {
    const client = new Client();
    this.client = client;

    const ready = Promise.withResolvers<void>();
    client.once("ready", () => ready.resolve());
    client.once("error", (err) => ready.reject(err));
    client.once("close", () => {
      if (this.client === client) {
        this.client = undefined;
        this.sftpPromise = undefined;
      }
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

    const sftpReady = Promise.withResolvers<SFTPWrapper>();
    client.sftp((err, sftp) => (err ? sftpReady.reject(err) : sftpReady.resolve(sftp)));
    return sftpReady.promise;
  }

  dispose(): void {
    this.client?.end();
    this.client = undefined;
    this.sftpPromise = undefined;
  }
}
