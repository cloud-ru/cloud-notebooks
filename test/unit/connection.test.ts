import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const { clients } = vi.hoisted(() => ({ clients: [] as unknown[] }));
vi.mock("ssh2", () => ({
  Client: class extends EventEmitter {
    connect = vi.fn(() => { clients.push(this); return this; });
    sftp = vi.fn((callback: (error: unknown, channel?: unknown) => void) => callback(undefined, { end: vi.fn() }));
    exec = vi.fn();
    forwardOut = vi.fn();
    end = vi.fn(() => this);
    destroy = vi.fn(() => this);
  },
}));

import { SshConnection } from "../../src/ssh/connection";

describe("SshConnection lifetime", () => {
  it("destroys a pending connection and rejects a late ready event", async () => {
    clients.length = 0;
    const connection = new SshConnection({ host: "gateway", port: 2222, username: "nb.account", privateKey: Buffer.from("key") });
    const opening = connection.sftp();
    const client = clients[0] as EventEmitter & { destroy: ReturnType<typeof vi.fn>; sftp: ReturnType<typeof vi.fn> };
    connection.dispose();
    client.emit("ready");
    await expect(opening).rejects.toThrow();
    expect(client.destroy).toHaveBeenCalled();
    expect(client.sftp).not.toHaveBeenCalled();
  });

  it("cancels an exec whose channel callback never arrives", async () => {
    clients.length = 0;
    const connection = new SshConnection({ host: "gateway", port: 2222, username: "nb.account", privateKey: Buffer.from("key") });
    const controller = new AbortController();
    const running = connection.exec("sh -s", "echo ready", controller.signal);
    const client = clients[0] as EventEmitter & { exec: ReturnType<typeof vi.fn> };
    client.emit("ready");
    await vi.waitFor(() => expect(client.exec).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(client.exec).toHaveBeenCalledTimes(1);
    connection.dispose();
  });

  it("opens an in-process channel to the requested pod address", async () => {
    clients.length = 0;
    const connection = new SshConnection({ host: "gateway", port: 2222, username: "nb.account", privateKey: Buffer.from("key") });
    const opening = connection.openStream("127.0.0.1", 8888);
    const client = clients[0] as EventEmitter & { forwardOut: ReturnType<typeof vi.fn> };
    client.emit("ready");
    await vi.waitFor(() => expect(client.forwardOut).toHaveBeenCalledTimes(1));
    const channel = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const [srcHost, srcPort, dstHost, dstPort, callback] = client.forwardOut.mock.calls[0] as [string, number, string, number, (error: Error | undefined, channel?: unknown) => void];
    expect([srcHost, srcPort, dstHost, dstPort]).toEqual(["127.0.0.1", 0, "127.0.0.1", 8888]);
    callback(undefined, channel);
    await expect(opening).resolves.toBe(channel);
    expect(channel.destroy).not.toHaveBeenCalled();
    connection.dispose();
  });

  it("rejects and destroys a channel that arrives after dispose", async () => {
    clients.length = 0;
    const connection = new SshConnection({ host: "gateway", port: 2222, username: "nb.account", privateKey: Buffer.from("key") });
    const opening = connection.openStream("127.0.0.1", 8888);
    const client = clients[0] as EventEmitter & { forwardOut: ReturnType<typeof vi.fn> };
    client.emit("ready");
    await vi.waitFor(() => expect(client.forwardOut).toHaveBeenCalledTimes(1));
    connection.dispose();
    const channel = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const callback = client.forwardOut.mock.calls[0]?.[4] as (error: Error | undefined, channel?: unknown) => void;
    callback(undefined, channel);
    await expect(opening).rejects.toThrow(/SSH connection was closed/);
    expect(channel.destroy).toHaveBeenCalled();
  });

  it("destroys channels it handed out when disposed", async () => {
    clients.length = 0;
    const connection = new SshConnection({ host: "gateway", port: 2222, username: "nb.account", privateKey: Buffer.from("key") });
    const opening = connection.openStream("127.0.0.1", 8888);
    const client = clients[0] as EventEmitter & { forwardOut: ReturnType<typeof vi.fn> };
    client.emit("ready");
    await vi.waitFor(() => expect(client.forwardOut).toHaveBeenCalledTimes(1));
    const channel = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const callback = client.forwardOut.mock.calls[0]?.[4] as (error: Error | undefined, channel?: unknown) => void;
    callback(undefined, channel);
    await expect(opening).resolves.toBe(channel);
    connection.dispose();
    expect(channel.destroy).toHaveBeenCalledTimes(1);
  });

  it("rejects openStream with the channel open error", async () => {
    clients.length = 0;
    const connection = new SshConnection({ host: "gateway", port: 2222, username: "nb.account", privateKey: Buffer.from("key") });
    const opening = connection.openStream("127.0.0.1", 8888);
    const client = clients[0] as EventEmitter & { forwardOut: ReturnType<typeof vi.fn> };
    client.emit("ready");
    await vi.waitFor(() => expect(client.forwardOut).toHaveBeenCalledTimes(1));
    const callback = client.forwardOut.mock.calls[0]?.[4] as (error: Error | undefined, channel?: unknown) => void;
    callback(new Error("open failed: connection refused"));
    await expect(opening).rejects.toThrow("open failed: connection refused");
    connection.dispose();
  });

  it("resolves ready() once the handshake completes", async () => {
    clients.length = 0;
    const connection = new SshConnection({ host: "gateway", port: 2222, username: "nb.account", privateKey: Buffer.from("key") });
    const handshake = connection.ready();
    (clients[0] as EventEmitter).emit("ready");
    await expect(handshake).resolves.toBeUndefined();
    connection.dispose();
  });

  it("rejects ready() when disposed before the handshake completes", async () => {
    clients.length = 0;
    const connection = new SshConnection({ host: "gateway", port: 2222, username: "nb.account", privateKey: Buffer.from("key") });
    const handshake = connection.ready();
    const client = clients[0] as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
    connection.dispose();
    client.emit("ready");
    await expect(handshake).rejects.toThrow(/SSH connection was closed/);
    expect(client.destroy).toHaveBeenCalled();
  });

  it("cancels an exec before SSH authentication becomes ready", async () => {
    clients.length = 0;
    const connection = new SshConnection({ host: "gateway", port: 2222, username: "nb.account", privateKey: Buffer.from("key") });
    const controller = new AbortController();
    const running = connection.exec("sh -s", undefined, controller.signal);
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    connection.dispose();
    expect((clients[0] as { destroy: ReturnType<typeof vi.fn> }).destroy).toHaveBeenCalled();
  });
});
