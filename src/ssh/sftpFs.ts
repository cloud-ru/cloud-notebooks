import { posix } from "node:path";
import * as vscode from "vscode";
import type { FileEntry, SFTPWrapper, Stats } from "ssh2";
import { SshConnection, type SshConnectionConfig } from "./connection";
import { classifySftpError } from "./sftpErrors";

export const SSH_SCHEME = "cloudru-ssh";

/** Bridge a node-style `(err, res)` SFTP call into a promise. One shared helper, many call sites. */
function call<T>(run: (cb: (err: unknown, res?: T) => void) => void): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  run((err, res) => (err ? reject(err) : resolve(res as T)));
  return promise;
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

/** Derive a VS Code FileType from a POSIX mode (works for both ssh2 `Stats` and readdir `Attributes`). */
function toFileType(attrs: { mode?: number }): vscode.FileType {
  const fmt = (attrs.mode ?? 0) & S_IFMT;
  if (fmt === S_IFLNK) return vscode.FileType.SymbolicLink;
  if (fmt === S_IFDIR) return vscode.FileType.Directory;
  return vscode.FileType.File;
}

function toFsError(error: unknown, uri: vscode.Uri): vscode.FileSystemError {
  switch (classifySftpError(error)) {
    case "FileNotFound":
      return vscode.FileSystemError.FileNotFound(uri);
    case "NoPermissions":
      return vscode.FileSystemError.NoPermissions(uri);
    case "FileExists":
      return vscode.FileSystemError.FileExists(uri);
    default:
      return vscode.FileSystemError.Unavailable(`${uri.toString()}: ${(error as Error)?.message ?? String(error)}`);
  }
}

/**
 * A `FileSystemProvider` backed by SFTP. Each `cloudru-ssh://<authority>/<path>` authority is a
 * registered notebook SSH target. File ops map straight onto SFTP; `watch` is a no-op (Phase 1).
 */
export class CloudruSshFsProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private readonly connections = new Map<string, SshConnection>();

  register(authority: string, config: SshConnectionConfig): void {
    this.connections.get(authority)?.dispose();
    this.connections.set(authority, new SshConnection(config));
  }

  /** Resolve the login home directory of an authority (used as the mount root). */
  async resolveHome(authority: string): Promise<string> {
    const sftp = await this.sftpFor(authority);
    return call<string>((cb) => sftp.realpath(".", (err, abs) => cb(err, abs)));
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    try {
      const sftp = await this.sftpFor(uri.authority);
      const stats = await call<Stats>((cb) => sftp.stat(this.path(uri), (err, s) => cb(err, s)));
      return {
        type: toFileType(stats),
        ctime: (stats.mtime ?? 0) * 1000,
        mtime: (stats.mtime ?? 0) * 1000,
        size: stats.size ?? 0,
      };
    } catch (err) {
      throw toFsError(err, uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    try {
      const sftp = await this.sftpFor(uri.authority);
      const entries = await call<FileEntry[]>((cb) => sftp.readdir(this.path(uri), (err, list) => cb(err, list)));
      return entries.map((entry): [string, vscode.FileType] => [entry.filename, toFileType(entry.attrs)]);
    } catch (err) {
      throw toFsError(err, uri);
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    try {
      const sftp = await this.sftpFor(uri.authority);
      await call<void>((cb) => sftp.mkdir(this.path(uri), (err) => cb(err)));
    } catch (err) {
      throw toFsError(err, uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      const sftp = await this.sftpFor(uri.authority);
      return await call<Buffer>((cb) => sftp.readFile(this.path(uri), (err, data) => cb(err, data)));
    } catch (err) {
      throw toFsError(err, uri);
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    const sftp = await this.sftpFor(uri.authority);
    const exists = await this.exists(sftp, this.path(uri));
    if (!exists && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
    if (exists && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
    try {
      await call<void>((cb) => sftp.writeFile(this.path(uri), Buffer.from(content), (err) => cb(err)));
      this.emitter.fire([{ type: exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
    } catch (err) {
      throw toFsError(err, uri);
    }
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    try {
      const sftp = await this.sftpFor(uri.authority);
      await this.remove(sftp, this.path(uri), options.recursive);
      this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    } catch (err) {
      throw toFsError(err, uri);
    }
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    try {
      const sftp = await this.sftpFor(oldUri.authority);
      if (options.overwrite && (await this.exists(sftp, this.path(newUri)))) {
        await this.remove(sftp, this.path(newUri), true);
      }
      await call<void>((cb) => sftp.rename(this.path(oldUri), this.path(newUri), (err) => cb(err)));
      this.emitter.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri },
      ]);
    } catch (err) {
      throw toFsError(err, newUri);
    }
  }

  private async remove(sftp: SFTPWrapper, path: string, recursive: boolean): Promise<void> {
    const stats = await call<Stats>((cb) => sftp.lstat(path, (err, s) => cb(err, s)));
    if (!stats.isDirectory()) {
      await call<void>((cb) => sftp.unlink(path, (err) => cb(err)));
      return;
    }
    if (recursive) {
      const entries = await call<FileEntry[]>((cb) => sftp.readdir(path, (err, list) => cb(err, list)));
      for (const entry of entries) {
        await this.remove(sftp, posix.join(path, entry.filename), true);
      }
    }
    await call<void>((cb) => sftp.rmdir(path, (err) => cb(err)));
  }

  private async exists(sftp: SFTPWrapper, path: string): Promise<boolean> {
    try {
      await call<Stats>((cb) => sftp.lstat(path, (err, s) => cb(err, s)));
      return true;
    } catch {
      return false;
    }
  }

  private async sftpFor(authority: string): Promise<SFTPWrapper> {
    const connection = this.connections.get(authority);
    if (!connection) {
      throw vscode.FileSystemError.Unavailable(`No SSH connection registered for "${authority}".`);
    }
    return connection.sftp();
  }

  private path(uri: vscode.Uri): string {
    return uri.path || "/";
  }

  dispose(): void {
    for (const connection of this.connections.values()) connection.dispose();
    this.connections.clear();
    this.emitter.dispose();
  }
}
