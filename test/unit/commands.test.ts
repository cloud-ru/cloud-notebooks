import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api/errors";

const { handlers, showInputBox, showWarningMessage, showErrorMessage } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<void>>(),
  showInputBox: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
}));
vi.mock("vscode", () => ({
  ProgressLocation: { Notification: 1 },
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => Promise<void>) => {
      handlers.set(id, handler);
      return { dispose() {} };
    },
  },
  window: {
    showInputBox, showWarningMessage, showErrorMessage,
    withProgress: vi.fn(async (_options, work) => work({}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) })),
  },
}));
vi.mock("../../src/console/tokenProvider", () => ({ NotSignedInError: class extends Error {} }));
vi.mock("../../src/views/notebooksTree", () => ({
  NotebookTreeItem: class {
    constructor(public notebook: unknown, public favorite: boolean, public contextGeneration: number) {}
  },
}));

import { registerCommands } from "../../src/commands";
import { NotebookTreeItem } from "../../src/views/notebooksTree";

describe("notebook commands", () => {
  beforeEach(() => { vi.clearAllMocks(); handlers.clear(); });
  it("does not modify the old workspace after it changes during description input", async () => {
    let submit!: (value: string) => void;
    showInputBox.mockImplementation(() => new Promise<string>((resolve) => { submit = resolve; }));
    const modifyNotebook = vi.fn(async () => {});
    let generation = 1;
    const ws = { workspaceId: "A", workspaceName: "A" };
    registerCommands({
      auth: {} as never,
      client: { modifyNotebook } as never,
      session: { get: () => ws, getGeneration: () => generation } as never,
      tree: { refresh: vi.fn(), isFavorite: () => false } as never,
      notebooks: {} as never,
      serverProvider: {} as never,
      ssh: {} as never,
      logger: { error: vi.fn() } as never,
    });
    const item = new NotebookTreeItem({ uid: "nb", name: "nb", description: "old", status: "running" } as never, false, generation);
    const running = handlers.get("cloudru.editDescription")!(item);
    generation++;
    submit("new");
    await running;
    expect(modifyNotebook).not.toHaveBeenCalled();
  });

  it("uses freshly fetched settings when saving a description", async () => {
    showInputBox.mockResolvedValue("new description");
    const modifyNotebook = vi.fn(async () => {});
    const listNotebooks = vi.fn(async () => [{
      uid: "nb", name: "nb", s3Buckets: [{ name: "new-bucket", accessRule: "rw" }],
      autoshutdownConfig: { by_timer: 60 },
    }]);
    registerCommands({
      auth: {} as never,
      client: { modifyNotebook, listNotebooks } as never,
      session: { get: () => ({ workspaceId: "A" }), getGeneration: () => 1 } as never,
      tree: { refresh: vi.fn(), isFavorite: () => false } as never,
      notebooks: {} as never, serverProvider: {} as never, ssh: {} as never,
      logger: { error: vi.fn() } as never,
    });
    const item = new NotebookTreeItem({
      uid: "nb", name: "nb", s3Buckets: [{ name: "old-bucket" }],
      autoshutdownConfig: { by_timer: 10 }, status: "running",
    } as never, false, 1);
    await handlers.get("cloudru.editDescription")!(item);
    expect(modifyNotebook).toHaveBeenCalledWith(
      { workspaceId: "A" }, "nb",
      { description: "new description", s3_buckets: [{ bucket_name: "new-bucket", access_rule: "rw" }], autoshutdown_config: { by_timer: 60 } },
    );
  });

  it("sends one pause request for two clicks while the first is pending", async () => {
    showWarningMessage.mockResolvedValue("Остановить");
    const submitted = Promise.withResolvers<void>();
    const pauseNotebook = vi.fn(() => submitted.promise);
    const ws = { workspaceId: "A", workspaceName: "A" };
    registerCommands({
      auth: {} as never,
      client: { pauseNotebook, listNotebooks: vi.fn(async () => [{ uid: "nb", status: "paused" }]) } as never,
      session: { get: () => ws, getGeneration: () => 1 } as never,
      tree: { applyNotebooks: vi.fn(), refresh: vi.fn(), isFavorite: () => false } as never,
      notebooks: { invalidate: vi.fn() } as never,
      serverProvider: { invalidate: vi.fn() } as never,
      ssh: { invalidate: vi.fn() } as never,
      logger: { error: vi.fn() } as never,
    });
    const item = new NotebookTreeItem({ uid: "nb", name: "nb", status: "running" } as never, false, 1);
    const first = handlers.get("cloudru.pauseNotebook")!(item);
    const second = handlers.get("cloudru.pauseNotebook")!(item);
    await vi.waitFor(() => expect(pauseNotebook).toHaveBeenCalledTimes(1));
    expect(pauseNotebook).toHaveBeenCalledTimes(1);
    submitted.resolve();
    await Promise.all([first, second]);
  });

  it("never replays a pause POST after an ambiguous network failure", async () => {
    showWarningMessage.mockResolvedValue("Остановить");
    const pauseNotebook = vi.fn(async () => { throw new ApiError("network", "connection lost"); });
    showErrorMessage.mockResolvedValueOnce("Повторить").mockResolvedValue(undefined);
    registerCommands({
      auth: {} as never,
      client: { pauseNotebook } as never,
      session: { get: () => ({ workspaceId: "A" }), getGeneration: () => 1 } as never,
      tree: { refresh: vi.fn(), isFavorite: () => false } as never,
      notebooks: {} as never, serverProvider: {} as never, ssh: {} as never,
      logger: { error: vi.fn() } as never,
    });
    const item = new NotebookTreeItem({ uid: "nb", name: "nb", status: "running" } as never, false, 1);
    await handlers.get("cloudru.pauseNotebook")!(item);
    expect(pauseNotebook).toHaveBeenCalledTimes(1);
  });

  it("reconciles a lost pause response with the current server status", async () => {
    showWarningMessage.mockResolvedValue("Остановить");
    const pauseNotebook = vi.fn(async () => { throw new ApiError("network", "connection lost"); });
    const invalidate = vi.fn();
    const listNotebooks = vi.fn(async () => [{ uid: "nb", status: "paused" }]);
    registerCommands({
      auth: {} as never,
      client: { pauseNotebook, listNotebooks } as never,
      session: { get: () => ({ workspaceId: "A" }), getGeneration: () => 1 } as never,
      tree: { applyNotebooks: vi.fn(), refresh: vi.fn(), isFavorite: () => false } as never,
      notebooks: { invalidate } as never,
      serverProvider: { invalidate: vi.fn() } as never,
      ssh: { invalidate: vi.fn() } as never,
      logger: { error: vi.fn() } as never,
    });
    await handlers.get("cloudru.pauseNotebook")!(new NotebookTreeItem({ uid: "nb", name: "nb", status: "running" } as never, false, 1));
    expect(pauseNotebook).toHaveBeenCalledTimes(1);
    expect(listNotebooks).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith("nb");
  });

  it("does not pause the old item if the workspace changes during confirmation", async () => {
    const confirmation = Promise.withResolvers<string>();
    showWarningMessage.mockReturnValue(confirmation.promise);
    const pauseNotebook = vi.fn();
    let generation = 1;
    registerCommands({
      auth: {} as never,
      client: { pauseNotebook } as never,
      session: { get: () => ({ workspaceId: generation === 1 ? "A" : "B" }), getGeneration: () => generation } as never,
      tree: { isFavorite: () => false } as never, notebooks: {} as never, serverProvider: {} as never, ssh: {} as never,
      logger: { error: vi.fn() } as never,
    });
    const running = handlers.get("cloudru.pauseNotebook")!(new NotebookTreeItem({ uid: "nb", name: "nb", status: "running" } as never, false, 1));
    generation++;
    confirmation.resolve("Остановить");
    await running;
    expect(pauseNotebook).not.toHaveBeenCalled();
  });

  it("does not resume when project access cannot be verified", async () => {
    const resumeNotebook = vi.fn(async () => { throw new Error("unexpected submit"); });
    registerCommands({
      auth: {} as never,
      client: {
        getProjectStatus: vi.fn(async () => { throw new ApiError("forbidden", "access denied", { status: 403 }); }),
        resumeNotebook,
      } as never,
      session: { get: () => ({ workspaceId: "A", namespace: "accountA" }), getGeneration: () => 1 } as never,
      tree: { isFavorite: () => false } as never, notebooks: {} as never, serverProvider: {} as never, ssh: {} as never,
      logger: { error: vi.fn() } as never,
    });
    await handlers.get("cloudru.resumeNotebook")!(new NotebookTreeItem({
      uid: "nb", name: "nb", status: "paused", imageSource: "artifact_registry",
    } as never, false, 1));
    expect(resumeNotebook).not.toHaveBeenCalled();
  });
});
