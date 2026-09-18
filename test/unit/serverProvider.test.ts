import { describe, expect, it, vi } from "vitest";

const { forwards } = vi.hoisted(() => ({
  forwards: [] as Array<{ finish: (port: number) => void; dispose: ReturnType<typeof vi.fn> }>,
}));
vi.mock("vscode", () => ({
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  Uri: { parse: (value: string) => value },
}));
vi.mock("../../src/ssh/connection", () => ({
  SshConnection: class {
    dispose = vi.fn();
    forward = vi.fn(() => new Promise<number>((resolve) => { forwards.push({ finish: resolve, dispose: this.dispose }); }));
  },
}));
vi.mock("../../src/jupyter/httpProbe", () => ({ probeHttpAlive: vi.fn(async () => true) }));
vi.mock("../../src/console/tokenProvider", () => ({ NotSignedInError: class extends Error {} }));

import { CloudruServerProvider } from "../../src/jupyter/serverProvider";

const notebook = { uid: "nb", name: "nb", status: "running", url: "https://example.com/sr008-mt/notebook/nb" } as never;

describe("CloudruServerProvider resource lifetime", () => {
  it("surfaces a list failure instead of presenting an empty kernel picker", async () => {
    const provider = new CloudruServerProvider({
      config: {} as never,
      getRunningNotebooks: async () => { throw new Error("offline"); },
      logger: { info: vi.fn(), error: vi.fn() } as never,
    });
    await expect(provider.provideJupyterServers()).rejects.toThrow("offline");
  });
  it("ignores a late list after disposal", async () => {
    let finish!: (items: never[]) => void;
    const provider = new CloudruServerProvider({
      config: {} as never,
      getRunningNotebooks: () => new Promise((resolve) => { finish = resolve; }),
      logger: { info: vi.fn(), error: vi.fn() } as never,
    });
    const listing = provider.provideJupyterServers();
    provider.disposeAll();
    finish([notebook]);
    expect(await listing).toEqual([]);
    await expect(provider.resolveJupyterServer({ id: "nb" } as never)).rejects.toThrow(/no longer available/);
  });

  it("shares a forward and closes a late connection after disposal", async () => {
    forwards.length = 0;
    const resolveTarget = vi.fn(async () => ({ host: "gateway", port: 2222, username: "nb.account", privateKey: Buffer.from("key") }));
    const provider = new CloudruServerProvider({
      config: { resolveTarget } as never,
      getRunningNotebooks: async () => [notebook],
      logger: { info: vi.fn(), error: vi.fn() } as never,
    });
    await provider.provideJupyterServers();
    const first = provider.resolveJupyterServer({ id: "nb" } as never);
    const second = provider.resolveJupyterServer({ id: "nb" } as never);
    while (!forwards.length) await Promise.resolve();
    expect(resolveTarget).toHaveBeenCalledTimes(1);
    expect(forwards).toHaveLength(1);
    provider.disposeAll();
    forwards[0].finish(12345);
    await expect(first).rejects.toThrow(/context changed/);
    await expect(second).rejects.toThrow(/context changed/);
    expect(forwards[0].dispose).toHaveBeenCalled();
  });
});
