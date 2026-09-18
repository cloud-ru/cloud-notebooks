import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const { clients } = vi.hoisted(() => ({ clients: [] as unknown[] }));
vi.mock("ssh2", () => ({
  Client: class extends EventEmitter {
    connect = vi.fn(() => { clients.push(this); return this; });
    sftp = vi.fn((callback: (error: unknown, channel?: unknown) => void) => callback(undefined, { end: vi.fn() }));
    exec = vi.fn();
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

  it("rejects a forward disposed before its listen callback fires", async () => {
    clients.length = 0;
    const connection = new SshConnection({ host: "gateway", port: 2222, username: "nb.account", privateKey: Buffer.from("key") });
    const pending = connection.forward("127.0.0.1", 8888);
    const client = clients[0] as EventEmitter;
    client.emit("ready");
    // Drain only microtask turns: the forward continuation advances to server.listen(), while the
    // 'listening' event (queued via nextTick) stays pending — exactly the dispose() race window.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    connection.dispose();
    await expect(pending).rejects.toThrow(/SSH connection was closed/);
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
