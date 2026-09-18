import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable, Writable } from "node:stream";

const { sftp, calls, fileEvents } = vi.hoisted(() => {
  const calls: string[] = [];
  const fileEvents: unknown[] = [];
  const sftp = {
    lstat: vi.fn(), stat: vi.fn(), readdir: vi.fn(), readFile: vi.fn(),
    writeFile: vi.fn(), createReadStream: vi.fn(), createWriteStream: vi.fn(),
    mkdir: vi.fn(), unlink: vi.fn(), rmdir: vi.fn(), rename: vi.fn(), realpath: vi.fn(),
  };
  return { sftp, calls, fileEvents };
});

vi.mock("vscode", () => {
  class FileSystemError extends Error {
    static FileNotFound(value?: unknown) { return new FileSystemError(`FileNotFound: ${String(value)}`); }
    static FileExists(value?: unknown) { return new FileSystemError(`FileExists: ${String(value)}`); }
    static NoPermissions(value?: unknown) { return new FileSystemError(`NoPermissions: ${String(value)}`); }
    static Unavailable(value?: unknown) { return new FileSystemError(`Unavailable: ${String(value)}`); }
  }
  return {
    FileSystemError,
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    EventEmitter: class { event = () => ({ dispose() {} }); fire(events: unknown) { fileEvents.push(events); } dispose() {} },
    Disposable: class { constructor(public dispose: () => void) {} },
  };
});

vi.mock("../../src/ssh/connection", () => ({
  SshConnection: class { async sftp() { return sftp; } dispose() {} },
}));

import { CloudruSshFsProvider } from "../../src/ssh/sftpFs";

function uri(authority: string, path: string) {
  return { authority, path, with: ({ path: next }: { path: string }) => uri(authority, next), toString: () => `${authority}:${path}` } as never;
}

function provider() {
  const fs = new CloudruSshFsProvider();
  fs.register("A", {} as never);
  return fs;
}

beforeEach(() => {
  calls.length = 0;
  fileEvents.length = 0;
  vi.clearAllMocks();
  sftp.lstat.mockImplementation((path: string, cb: (err: unknown, stats?: unknown) => void) => {
    calls.push(`lstat:${path}`);
    cb(path === "/missing" ? { code: 2 } : null, {
      isDirectory: () => path === "/dir" || path === "/",
      isSymbolicLink: () => false,
    });
  });
  sftp.realpath.mockImplementation((path: string, cb: (err: unknown, real?: string) => void) => {
    cb(null, path === "/shortcut" ? "/dir" : path);
  });
  sftp.readdir.mockImplementation((_path: string, cb: (err: unknown, entries?: unknown[]) => void) => cb(null, []));
  sftp.readFile.mockImplementation((_path: string, cb: (err: unknown, content?: Buffer) => void) => cb(null, Buffer.from("source")));
  sftp.writeFile.mockImplementation((path: string, _content: Buffer, cb: (err: unknown) => void) => { calls.push(`write:${path}`); cb(null); });
  sftp.createReadStream.mockImplementation((path: string) => { calls.push(`readStream:${path}`); return Readable.from([Buffer.from("source")]); });
  sftp.createWriteStream.mockImplementation((path: string) => new Writable({
    write(_chunk, _encoding, callback) { calls.push(`write:${path}`); callback(); },
  }));
  sftp.mkdir.mockImplementation((path: string, cb: (err: unknown) => void) => { calls.push(`mkdir:${path}`); cb(null); });
  sftp.unlink.mockImplementation((path: string, cb: (err: unknown) => void) => { calls.push(`unlink:${path}`); cb(null); });
  sftp.rename.mockImplementation((_src: string, _dst: string, cb: (err: unknown) => void) => { calls.push("rename"); cb(new Error("rename failed")); });
});

describe("CloudruSshFsProvider mutations", () => {
  it("does not publish a reconnect completed after context reset", async () => {
    let finish!: (config: unknown) => void;
    const fs = new CloudruSshFsProvider(() => new Promise((resolve) => { finish = resolve; }));
    const reading = fs.readFile(uri("old", "/data"));
    fs.reset();
    finish({});
    await expect(reading).rejects.toThrow();
    expect(sftp.readFile).not.toHaveBeenCalled();
  });

  it("rejects cross-authority copy before any SFTP operation", async () => {
    await expect(provider().copy(uri("A", "/source"), uri("B", "/target"), { overwrite: true })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("rejects copying a directory into itself before mkdir", async () => {
    await expect(provider().copy(uri("A", "/dir"), uri("A", "/dir/child"), { overwrite: true })).rejects.toThrow();
    expect(calls).not.toContain("mkdir:/dir/child");
  });

  it("rejects copying the mount root into a child before mkdir", async () => {
    await expect(provider().copy(uri("A", "/"), uri("A", "/child"), { overwrite: true })).rejects.toThrow();
    expect(calls).not.toContain("mkdir:/child");
  });

  it("rejects a directory copy through a symlinked parent", async () => {
    await expect(provider().copy(uri("A", "/dir"), uri("A", "/shortcut/child"), { overwrite: true })).rejects.toThrow();
    expect(calls).not.toContain("mkdir:/shortcut/child");
  });

  it("emits a create event after mkdir succeeds", async () => {
    await provider().createDirectory(uri("A", "/new"));
    expect(fileEvents).toMatchObject([[{ type: 2, uri: { authority: "A", path: "/new" } }]]);
  });

  it("maps a failed existence check to an editor file error", async () => {
    sftp.lstat.mockImplementationOnce((_path: string, cb: (err: unknown) => void) => cb({ code: "EACCES" }));
    await expect(provider().writeFile(uri("A", "/target"), Buffer.from("x"), { create: true, overwrite: true }))
      .rejects.toThrow(/NoPermissions/);
    expect(sftp.writeFile).not.toHaveBeenCalled();
  });

  it("refuses to replace an existing destination before any mutation", async () => {
    await expect(provider().rename(uri("A", "/source"), uri("A", "/target"), { overwrite: true }))
      .rejects.toThrow(/NoPermissions/);
    expect(calls).not.toContain("unlink:/target");
    expect(calls).not.toContain("rename");
  });

  it("propagates a rename failure without destructive side effects", async () => {
    await expect(provider().rename(uri("A", "/source"), uri("A", "/missing"), { overwrite: false })).rejects.toThrow();
    expect(calls).toContain("rename");
    expect(calls).not.toContain("unlink:/missing");
    expect(fileEvents).toEqual([]);
  });

  it("rejects self-rename before touching the destination", async () => {
    await expect(provider().rename(uri("A", "/source"), uri("A", "/source"), { overwrite: true })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("copies a file within the same server", async () => {
    await provider().copy(uri("A", "/source"), uri("A", "/missing"), { overwrite: false });
    expect(calls).toContain("write:/missing");
    expect(calls).toContain("readStream:/source");
    expect(sftp.readFile).not.toHaveBeenCalled();
  });
});
