import { describe, expect, it, vi } from "vitest";

const { forwards, openPanel, asExternalUri } = vi.hoisted(() => ({
  forwards: [] as Array<{ finish: (port: number) => void; dispose: ReturnType<typeof vi.fn> }>,
  openPanel: vi.fn(),
  asExternalUri: vi.fn(),
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
    forward = vi.fn(() => new Promise<number>((resolve) => { forwards.push({ finish: resolve, dispose: this.dispose }); }));
  },
}));
vi.mock("../../src/jupyter/notebookPanel", () => ({ openNotebookPanel: openPanel }));
vi.mock("../../src/jupyter/shim", () => ({ NotebookShim: class {
  baseUrl = "http://127.0.0.1:12346";
  start = vi.fn(async () => this.baseUrl);
  dispose = vi.fn();
} }));
vi.mock("../../src/jupyter/httpProbe", () => ({ probeHttpAlive: vi.fn(async () => true) }));
vi.mock("node:http", async () => {
  const { EventEmitter } = await import("node:events");
  return ({
  get: (_opts: unknown, callback: (response: unknown) => void) => {
    callback({ statusCode: 404, resume: vi.fn() });
    return new EventEmitter();
  },
  });
});

import { NotebookViewController } from "../../src/jupyter/notebookController";

describe("NotebookViewController resource lifetime", () => {
  it("shares an in-flight open and drops its late connection after disposal", async () => {
    forwards.length = 0;
    openPanel.mockClear();
    asExternalUri.mockClear();
    const resolveTarget = vi.fn(async () => ({ host: "gateway", port: 2222, username: "nb.account", privateKey: Buffer.from("key") }));
    const controller = new NotebookViewController({ config: { resolveTarget } as never, logger: { info: vi.fn(), error: vi.fn() } as never });
    const notebook = { uid: "nb", name: "nb", status: "running", url: "https://example.com/sr008-mt/notebook/nb" } as never;
    const first = controller.open(notebook);
    const second = controller.open(notebook);
    while (!forwards.length) await Promise.resolve();
    expect(resolveTarget).toHaveBeenCalledTimes(1);
    expect(forwards).toHaveLength(1);
    controller.disposeAll();
    forwards[0].finish(12345);
    await Promise.all([first, second]);
    expect(forwards[0].dispose).toHaveBeenCalled();
    expect(openPanel).not.toHaveBeenCalled();
    expect(asExternalUri).not.toHaveBeenCalled();
  });

  it("does not open a webview when both application paths fail", async () => {
    forwards.length = 0;
    openPanel.mockClear();
    asExternalUri.mockImplementation(async (uri: unknown) => uri);
    openPanel.mockReturnValue({ onDidDispose: vi.fn(), dispose: vi.fn() });
    const resolveTarget = vi.fn(async () => ({ host: "gateway", port: 2222, username: "nb.account", privateKey: Buffer.from("key") }));
    const controller = new NotebookViewController({ config: { resolveTarget } as never, logger: { info: vi.fn(), error: vi.fn() } as never });
    const pending = controller.open({ uid: "nb", name: "nb", status: "running", url: "https://example.com/sr008-mt/notebook/nb" } as never);
    await vi.waitFor(() => expect(forwards).toHaveLength(1));
    forwards[0].finish(12345);
    await pending;
    expect(openPanel).not.toHaveBeenCalled();
    expect(forwards[0].dispose).toHaveBeenCalled();
  });
});
