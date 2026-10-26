import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const { shims } = vi.hoisted(() => ({
  shims: [] as Array<{ finish: (url: string) => void; dispose: Mock }>,
}));
vi.mock("vscode", () => ({
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  Uri: { parse: (value: string) => value },
}));
vi.mock("../../src/ssh/connection", () => ({
  SshConnection: class {
    dispose = vi.fn();
    ready = vi.fn(async () => {});
    openStream = vi.fn();
  },
}));
vi.mock("../../src/jupyter/sshAgent", () => ({ createSshTunnelAgent: vi.fn(() => ({})) }));
vi.mock("../../src/jupyter/shim", () => ({
  NotebookShim: class {
    baseUrl = "";
    token = "tok";
    bootstrapQuery = "cloudru_shim=tok";
    authHeaders = { authorization: "token tok" };
    dispose = vi.fn();
    start = vi.fn(() => {
      const { promise, resolve } = Promise.withResolvers<string>();
      shims.push({ finish: (url) => { this.baseUrl = url; resolve(url); }, dispose: this.dispose });
      return promise;
    });
  },
}));
vi.mock("../../src/jupyter/httpProbe", () => ({ probeHttpAlive: vi.fn(async () => true) }));
vi.mock("../../src/console/tokenProvider", () => ({ NotSignedInError: class extends Error {} }));

import { CloudruServerProvider } from "../../src/jupyter/serverProvider";

const notebook = { uid: "nb", name: "nb", status: "running", url: "https://example.com/sr008-mt/notebook/nb" } as never;

beforeEach(() => { shims.length = 0; });

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

  it("shares a tunnel and closes a late shim after disposal", async () => {
    const resolveTarget = vi.fn(async () => ({ host: "gateway", port: 2222, username: "nb.account", privateKey: Buffer.from("key") }));
    const provider = new CloudruServerProvider({
      config: { resolveTarget } as never,
      getRunningNotebooks: async () => [notebook],
      logger: { info: vi.fn(), error: vi.fn() } as never,
    });
    await provider.provideJupyterServers();
    const first = provider.resolveJupyterServer({ id: "nb" } as never);
    const second = provider.resolveJupyterServer({ id: "nb" } as never);
    while (!shims.length) await Promise.resolve();
    expect(resolveTarget).toHaveBeenCalledTimes(1);
    expect(shims).toHaveLength(1);
    provider.disposeAll();
    shims[0].finish("http://127.0.0.1:12345");
    await expect(first).rejects.toThrow(/context changed/);
    await expect(second).rejects.toThrow(/context changed/);
    expect(shims[0].dispose).toHaveBeenCalled();
  });

  it("hands the Jupyter extension the shim URL with the shim token", async () => {
    const resolveTarget = vi.fn(async () => ({ host: "gateway", port: 2222, username: "nb.account", privateKey: Buffer.from("key") }));
    const provider = new CloudruServerProvider({
      config: { resolveTarget } as never,
      getRunningNotebooks: async () => [notebook],
      logger: { info: vi.fn(), error: vi.fn() } as never,
    });
    await provider.provideJupyterServers();
    const resolving = provider.resolveJupyterServer({ id: "nb", label: "nb" });
    await vi.waitFor(() => expect(shims).toHaveLength(1));
    shims[0].finish("http://127.0.0.1:12345");
    const { connectionInformation } = await resolving;
    expect(connectionInformation?.token).toBe("tok");
    expect(String(connectionInformation?.baseUrl)).toBe("http://127.0.0.1:12345/sr008-mt/notebook/nb/");
  });
});
