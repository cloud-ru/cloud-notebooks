import { beforeEach, describe, expect, it, vi } from "vitest";

const { contexts } = vi.hoisted(() => ({ contexts: new Map<string, unknown>() }));
vi.mock("vscode", () => ({
  EventEmitter: class<T> {
    private listeners: Array<(value: T) => void> = [];
    event = (listener: (value: T) => void) => { this.listeners.push(listener); return { dispose() {} }; };
    fire(value: T) { for (const listener of this.listeners) listener(value); }
    dispose() {}
  },
  TreeItem: class { constructor(public label: string) {} },
  TreeItemCollapsibleState: { None: 0 },
  ThemeIcon: class { constructor(public id: string) {} },
  ThemeColor: class { constructor(public id: string) {} },
  MarkdownString: class {
    parts: Array<{ type: string; value: string }> = [];
    appendMarkdown(value: string) { this.parts.push({ type: "markdown", value }); }
    appendText(value: string) { this.parts.push({ type: "text", value }); }
  },
  commands: { executeCommand: vi.fn(async (_command: string, key: string, value: unknown) => contexts.set(key, value)) },
}));
vi.mock("../../src/console/tokenProvider", () => ({ NotSignedInError: class extends Error {} }));

import { SessionStore } from "../../src/session/sessionStore";
import { NotebookTreeItem, NotebooksTreeProvider } from "../../src/views/notebooksTree";
import { NotSignedInError } from "../../src/console/tokenProvider";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function notebook(uid: string) {
  return { uid, name: uid, status: "running", imageDisplayName: "image", region: "ru", author: "test" } as never;
}

function setup() {
  const values = new Map<string, string>();
  const session = new SessionStore({
    get: async (key: string) => values.get(key),
    store: async (key: string, value: string) => { values.set(key, value); },
    delete: async (key: string) => { values.delete(key); },
  } as never);
  const requests: Array<{ workspaceId: string; pending: ReturnType<typeof deferred<never[]>> }> = [];
  const client = { listNotebooks: vi.fn((ws: { workspaceId: string }) => {
    const pending = deferred<never[]>();
    requests.push({ workspaceId: ws.workspaceId, pending });
    return pending.promise;
  }) };
  let signedIn = true;
  const tree = new NotebooksTreeProvider({
    client: client as never, session,
    favorites: { has: () => false } as never,
    isSignedIn: () => signedIn,
    logger: { error: vi.fn() } as never,
  });
  const view = { message: "" };
  tree.attachView(view as never);
  session.onDidChangeWorkspace(() => tree.resetContext());
  return { session, tree, view, client, requests, signOut: () => { signedIn = false; session.invalidateAuthContext(); tree.resetContext(); } };
}

beforeEach(() => contexts.clear());

describe("NotebooksTreeProvider context", () => {
  it("treats notebook metadata as plain text in the tooltip", () => {
    const item = new NotebookTreeItem({ ...notebook("[name](command:evil)"), description: "**description**" } as never, false, 1);
    const parts = (item.tooltip as unknown as { parts: Array<{ type: string; value: string }> }).parts;
    expect(parts).toContainEqual({ type: "text", value: "[name](command:evil)" });
    expect(parts).toContainEqual({ type: "text", value: "**description**" });
    expect(parts.some((part) => part.type === "markdown" && part.value.includes("command:evil"))).toBe(false);
  });
  it("ignores a late A response after B has loaded", async () => {
    const { session, tree, requests } = setup();
    await session.set({ workspaceId: "A", workspaceName: "A" });
    const a = tree.getChildren();
    await Promise.resolve();
    await session.set({ workspaceId: "B", workspaceName: "B" });
    const b = tree.getChildren();
    await Promise.resolve();
    requests[1].pending.resolve([notebook("B")]);
    expect((await b).map((item) => item.notebook.uid)).toEqual(["B"]);
    requests[0].pending.resolve([notebook("A")]);
    expect(await a).toEqual([]);
    expect((await tree.getChildren()).map((item) => item.notebook.uid)).toEqual(["B"]);
  });

  it("does not show A if B's initial request fails", async () => {
    const { session, tree, requests } = setup();
    await session.set({ workspaceId: "A", workspaceName: "A" });
    const a = tree.getChildren();
    await Promise.resolve();
    requests[0].pending.resolve([notebook("A")]);
    await a;
    await session.set({ workspaceId: "B", workspaceName: "B" });
    const b = tree.getChildren();
    await Promise.resolve();
    requests[1].pending.reject(new Error("offline"));
    expect(await b).toEqual([]);
    expect(contexts.get("cloudru.loadError")).toBe(true);
  });

  it("clears a load error when poll supplies an empty successful list", async () => {
    const { session, tree, view, requests } = setup();
    await session.set({ workspaceId: "A", workspaceName: "A" });
    const load = tree.getChildren();
    await Promise.resolve();
    requests[0].pending.reject(new Error("offline"));
    await load;
    expect(view.message).toContain("offline");
    tree.applyNotebooks([], session.getGeneration());
    expect(view.message).not.toContain("offline");
    expect(contexts.get("cloudru.loadError")).toBe(false);
  });

  it("keeps a newer poll result when an older fetch completes", async () => {
    const { session, tree, requests } = setup();
    await session.set({ workspaceId: "A", workspaceName: "A" });
    const load = tree.getChildren();
    await Promise.resolve();
    tree.applyNotebooks([notebook("new")], session.getGeneration());
    requests[0].pending.resolve([notebook("old")]);
    expect((await load).map((item) => item.notebook.uid)).toEqual(["new"]);
  });

  it("shows loading and filtered empty as separate states", async () => {
    const { session, tree, view, requests } = setup();
    await session.set({ workspaceId: "A", workspaceName: "A" });
    const load = tree.getChildren();
    await Promise.resolve();
    expect(view.message).toContain("Загружаем");
    expect(contexts.get("cloudru.loading")).toBe(true);
    requests[0].pending.resolve([notebook("one")]);
    await load;
    tree.setSearch("absent");
    expect(contexts.get("cloudru.filteredEmpty")).toBe(true);
    expect(view.message).toContain("0 из 1");
    expect(contexts.get("cloudru.loading")).toBe(false);
  });

  it("ignores old poll and fetch after logout", async () => {
    const { session, tree, requests, signOut } = setup();
    await session.set({ workspaceId: "A", workspaceName: "A" });
    const generation = session.getGeneration();
    const load = tree.getChildren();
    await Promise.resolve();
    signOut();
    tree.applyNotebooks([notebook("old")], generation);
    requests[0].pending.resolve([notebook("A")]);
    expect(await load).toEqual([]);
    expect(await tree.getChildren()).toEqual([]);
  });

  it("does not revive a pre-logout response after selecting the same workspace again", async () => {
    const { session, tree, requests } = setup();
    await session.set({ workspaceId: "A", workspaceName: "A" });
    const oldGeneration = session.getGeneration();
    const oldLoad = tree.getChildren();
    await Promise.resolve();
    session.invalidateAuthContext();
    await session.set({ workspaceId: "A", workspaceName: "A" });
    const newLoad = tree.getChildren();
    await Promise.resolve();
    requests[1].pending.resolve([notebook("new")]);
    await newLoad;
    tree.applyNotebooks([notebook("old")], oldGeneration);
    requests[0].pending.resolve([notebook("old")]);
    expect(await oldLoad).toEqual([]);
    expect((await tree.getChildren()).map((item) => item.notebook.uid)).toEqual(["new"]);
  });
});

describe("NotebooksTreeProvider signed-out view", () => {
  // VS Code hides the viewsWelcome content (with its «Войти» / «Выбрать воркспейс» button) whenever
  // the tree has a message, so every signed-out or workspace-less state must leave it empty.

  it("does not cover the sign-in welcome after the session expires", async () => {
    const { session, tree, view, requests, signOut } = setup();
    await session.set({ workspaceId: "A", workspaceName: "A" });
    const load = tree.getChildren();
    await Promise.resolve();
    requests[0].pending.resolve([notebook("one")]);
    await load;
    signOut();
    tree.refresh(); // extension.ts refreshes the tree at the end of its auth-change handler
    expect(view.message).toBe("");
    expect(await tree.getChildren()).toEqual([]);
    expect(view.message).toBe("");
  });

  it("drops the loading state when a load ends with NotSignedInError", async () => {
    const { session, tree, view, requests } = setup();
    await session.set({ workspaceId: "A", workspaceName: "A" });
    const load = tree.getChildren();
    await Promise.resolve();
    expect(view.message).toContain("Загружаем");
    requests[0].pending.reject(new NotSignedInError());
    expect(await load).toEqual([]);
    expect(view.message).not.toContain("Загружаем");
  });

  it("hides the filter summary while signed out", async () => {
    const { session, tree, view, requests, signOut } = setup();
    await session.set({ workspaceId: "A", workspaceName: "A" });
    const load = tree.getChildren();
    await Promise.resolve();
    requests[0].pending.resolve([notebook("one")]);
    await load;
    tree.setSearch("one");
    expect(view.message).toContain("1 из 1");
    signOut();
    expect(view.message).toBe("");
  });

  it("does not show a loading message without a workspace", async () => {
    const { tree, view, client } = setup();
    tree.refresh();
    expect(view.message).toBe("");
    expect(await tree.getChildren()).toEqual([]);
    expect(client.listNotebooks).not.toHaveBeenCalled();
    expect(view.message).toBe("");
  });

  it("shows the signing-in line only while the list is still empty", async () => {
    const { session, tree, view, requests } = setup();
    await session.set({ workspaceId: "A", workspaceName: "A" });
    const load = tree.getChildren();
    await Promise.resolve();
    tree.setSignInMessage("Выполняется вход в Cloud.ru…");
    expect(view.message).toContain("Выполняется вход");
    requests[0].pending.resolve([notebook("one")]);
    await load;
    expect(view.message).not.toContain("Выполняется вход");
    tree.refresh();
    expect(view.message).not.toContain("Выполняется вход");
  });
});
