import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const { shims, openPanel, asExternalUri, probe } = vi.hoisted(() => ({
  shims: [] as Array<{ finish: (url: string) => void; dispose: Mock }>,
  openPanel: vi.fn(),
  asExternalUri: vi.fn(),
  probe: { status: 404 },
}));
vi.mock("vscode", () => ({
  ProgressLocation: { Notification: 1 },
  window: { withProgress: (_options: unknown, task: () => Promise<unknown>) => task(), showWarningMessage: vi.fn(), showErrorMessage: vi.fn() },
  env: { asExternalUri },
  Uri: { parse: (value: string) => ({ toString: () => value }) },
}));
vi.mock("../../src/ssh/connection", () => ({
  SshConnection: class {
    dispose = vi.fn();
    ready = vi.fn(async () => {});
    openStream = vi.fn();
  },
}));
vi.mock("../../src/jupyter/sshAgent", () => ({ createSshTunnelAgent: vi.fn(() => ({})) }));
vi.mock("../../src/jupyter/notebookPanel", () => ({ openNotebookPanel: openPanel }));
vi.mock("../../src/jupyter/shim", () => ({ NotebookShim: class {
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
} }));
vi.mock("../../src/jupyter/httpProbe", () => ({ probeHttpAlive: vi.fn(async () => true) }));
vi.mock("node:http", async () => {
  const { EventEmitter } = await import("node:events");
  return ({
  get: (_opts: unknown, callback: (response: unknown) => void) => {
    callback({ statusCode: probe.status, resume: vi.fn() });
    return new EventEmitter();
  },
  });
});

import { NotebookViewController } from "../../src/jupyter/notebookController";

beforeEach(() => {
  shims.length = 0;
  probe.status = 404;
  openPanel.mockReset();
  asExternalUri.mockReset();
});

describe("NotebookViewController resource lifetime", () => {
  it("shares an in-flight open and drops its late connection after disposal", async () => {
    const resolveTarget = vi.fn(async () => ({ host: "gateway", port: 2222, username: "nb.account", privateKey: Buffer.from("key") }));
    const controller = new NotebookViewController({ config: { resolveTarget } as never, logger: { info: vi.fn(), error: vi.fn() } as never });
    const notebook = { uid: "nb", name: "nb", status: "running", url: "https://example.com/sr008-mt/notebook/nb" } as never;
    const first = controller.open(notebook);
    const second = controller.open(notebook);
    while (!shims.length) await Promise.resolve();
    expect(resolveTarget).toHaveBeenCalledTimes(1);
    expect(shims).toHaveLength(1);
    controller.disposeAll();
    shims[0].finish("http://127.0.0.1:12345");
    await Promise.all([first, second]);
    expect(shims[0].dispose).toHaveBeenCalled();
    expect(openPanel).not.toHaveBeenCalled();
    expect(asExternalUri).not.toHaveBeenCalled();
  });

  it("does not open a webview when both application paths fail", async () => {
    asExternalUri.mockImplementation(async (uri: unknown) => uri);
    openPanel.mockReturnValue({ onDidDispose: vi.fn(), dispose: vi.fn() });
    const resolveTarget = vi.fn(async () => ({ host: "gateway", port: 2222, username: "nb.account", privateKey: Buffer.from("key") }));
    const controller = new NotebookViewController({ config: { resolveTarget } as never, logger: { info: vi.fn(), error: vi.fn() } as never });
    const pending = controller.open({ uid: "nb", name: "nb", status: "running", url: "https://example.com/sr008-mt/notebook/nb" } as never);
    await vi.waitFor(() => expect(shims).toHaveLength(1));
    shims[0].finish("http://127.0.0.1:12345");
    await pending;
    expect(openPanel).not.toHaveBeenCalled();
    expect(shims[0].dispose).toHaveBeenCalled();
  });

  it("frames the shim with its bootstrap credential without logging it", async () => {
    probe.status = 200;
    asExternalUri.mockImplementation(async (uri: unknown) => uri);
    openPanel.mockReturnValue({ onDidDispose: vi.fn(), dispose: vi.fn() });
    const info = vi.fn();
    const resolveTarget = vi.fn(async () => ({ host: "gateway", port: 2222, username: "nb.account", privateKey: Buffer.from("key") }));
    const controller = new NotebookViewController({ config: { resolveTarget } as never, logger: { info, error: vi.fn() } as never });
    const pending = controller.open({ uid: "nb", name: "nb", status: "running", url: "https://example.com/sr008-mt/notebook/nb" } as never);
    await vi.waitFor(() => expect(shims).toHaveLength(1));
    shims[0].finish("http://127.0.0.1:12345");
    await pending;
    expect(openPanel).toHaveBeenCalledWith(expect.objectContaining({
      frameSrc: "http://127.0.0.1:12345/sr008-mt/notebook/nb/lab?cloudru_shim=tok",
    }));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("Opening notebook webview"));
    expect(info.mock.calls.flat().join("\n")).not.toContain("cloudru_shim");
  });
});
