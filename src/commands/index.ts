import * as vscode from "vscode";
import { ApiError } from "../api/errors";
import type { WorkspaceContext } from "../api/types";
import type { ConsoleApiClient, ConsoleWorkspace } from "../console/apiClient";
import type { ConsoleTokenProvider } from "../console/tokenProvider";
import { buildResumeBody } from "../console/resumeBody";
import type { SessionStore } from "../session/sessionStore";
import type { Logger } from "../util/logger";
import type { NotebookTreeItem, NotebooksTreeProvider } from "../views/notebooksTree";
import type { NotebookViewController } from "../jupyter/notebookController";
import type { SshController } from "../ssh/sshController";

export interface CommandDeps {
  auth: ConsoleTokenProvider;
  client: ConsoleApiClient;
  session: SessionStore;
  tree: NotebooksTreeProvider;
  notebooks: NotebookViewController;
  ssh: SshController;
  logger: Logger;
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const { auth, client, session, tree, notebooks, ssh, logger } = deps;

  const run = (id: string, body: (...args: unknown[]) => Promise<void>): vscode.Disposable =>
    vscode.commands.registerCommand(id, (...args: unknown[]) => withErrorHandling(auth, logger, body, ...args));

  return [
    run("cloudru.signIn", async () => {
      const ok = await auth.signIn();
      if (!ok) return;
      if (!session.get()) await selectWorkspace(client, session, logger);
      tree.refresh();
    }),

    run("cloudru.signOut", async () => {
      await auth.signOut();
      await session.clear();
      tree.refresh();
    }),

    run("cloudru.selectWorkspace", async () => {
      if (!(await auth.isSignedIn())) {
        void vscode.window.showWarningMessage("Sign in to Cloud.ru first.");
        return;
      }
      await selectWorkspace(client, session, logger);
      tree.refresh();
    }),

    run("cloudru.refreshNotebooks", async () => {
      tree.refresh();
    }),

    run("cloudru.searchNotebooks", async () => {
      const query = await vscode.window.showInputBox({
        title: "Search notebooks by name",
        prompt: "Type part of a notebook name (empty to clear).",
        ignoreFocusOut: true,
      });
      if (query === undefined) return; // cancelled — keep current filter
      tree.setSearch(query);
    }),

    run("cloudru.filterByAuthor", async () => {
      const authors = tree.authors();
      if (authors.length === 0) {
        void vscode.window.showInformationMessage("No notebooks loaded yet to filter by author.");
        return;
      }
      const picked = await vscode.window.showQuickPick(["All authors", ...authors], {
        title: "Filter notebooks by author",
        ignoreFocusOut: true,
      });
      if (picked === undefined) return;
      tree.setAuthor(picked === "All authors" ? undefined : picked);
    }),

    run("cloudru.toggleFavoritesFilter", async () => {
      tree.toggleFavoritesOnly();
    }),

    run("cloudru.clearFilters", async () => {
      tree.clearFilters();
    }),

    run("cloudru.addFavorite", async (...args: unknown[]) => {
      const item = args[0] as NotebookTreeItem | undefined;
      if (item) await tree.toggleFavorite(item.notebook.uid);
    }),

    run("cloudru.removeFavorite", async (...args: unknown[]) => {
      const item = args[0] as NotebookTreeItem | undefined;
      if (item) await tree.toggleFavorite(item.notebook.uid);
    }),
    run("cloudru.openNotebook", async (...args: unknown[]) => {
      const item = args[0] as NotebookTreeItem | undefined;
      if (!item) return;
      await notebooks.open(item.notebook);
    }),

    run("cloudru.openNotebookFiles", async (...args: unknown[]) => {
      const item = args[0] as NotebookTreeItem | undefined;
      if (!item) return;
      await ssh.openFiles(item.notebook);
    }),

    run("cloudru.openFullIde", async (...args: unknown[]) => {
      const item = args[0] as NotebookTreeItem | undefined;
      if (!item) return;
      await ssh.openFullIde(item.notebook);
    }),

    run("cloudru.pauseNotebook", async (...args: unknown[]) => {
      const item = args[0] as NotebookTreeItem | undefined;
      const ws = session.get();
      if (!item || !ws) return;
      await client.pauseNotebook(ws, item.notebook.uid);
      await pollUntil(client, ws, item.notebook.uid, tree, (s) => s.startsWith("paused"), `Pausing ${item.notebook.name}…`, 120_000);
    }),

    run("cloudru.resumeNotebook", async (...args: unknown[]) => {
      const item = args[0] as NotebookTreeItem | undefined;
      const ws = session.get();
      if (!item || !ws) return;
      const { namespace, name } = item.notebook;
      if (!namespace) {
        void vscode.window.showErrorMessage(`Cannot resume “${name}”: missing namespace.`);
        return;
      }
      await client.resumeNotebook(ws, namespace, buildResumeBody(item.notebook));
      await pollUntil(client, ws, item.notebook.uid, tree, (s) => s === "running", `Starting ${name}…`, 300_000);
    }),

    run("cloudru.configureSsh", async () => {
      await ssh.configure();
    }),

    run("cloudru.openNotebookInBrowser", async (...args: unknown[]) => {
      const item = args[0] as NotebookTreeItem | undefined;
      const url = item?.notebook.url;
      if (!url) {
        void vscode.window.showWarningMessage(
          "This notebook has no URL yet. It must be running before it can be opened.",
        );
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),
  ];
}

/**
 * Console workspace selection: pick from the user's workspaces (the chosen id becomes the
 * x-workspace-id header). Falls back to manual id entry if the list cannot be loaded.
 */
async function selectWorkspace(client: ConsoleApiClient, session: SessionStore, logger: Logger): Promise<void> {
  let workspaces: ConsoleWorkspace[];
  try {
    workspaces = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Loading Cloud.ru workspaces…" },
      () => client.listWorkspaces(),
    );
  } catch (err) {
    logger.error("Failed to load Cloud.ru workspaces", err);
    await enterWorkspaceIdManually(session, err);
    return;
  }
  if (workspaces.length === 0) {
    void vscode.window.showWarningMessage("No Cloud.ru workspaces are available for this account.");
    return;
  }

  const chosen = workspaces.length === 1 ? workspaces[0] : await pickWorkspace(workspaces);
  if (!chosen) return;
  await session.set({ workspaceId: chosen.workspace_id, workspaceName: chosen.workspace_name });
  void vscode.window.showInformationMessage(`Cloud.ru workspace: ${chosen.workspace_name}`);
}

async function pickWorkspace(workspaces: ConsoleWorkspace[]): Promise<ConsoleWorkspace | undefined> {
  const picked = await vscode.window.showQuickPick(
    workspaces.map((ws) => ({
      label: ws.workspace_name,
      ...(ws.project_name ? { description: ws.project_name } : {}),
      ...(ws.email ? { detail: ws.email } : {}),
      ws,
    })),
    { title: "Select Cloud.ru workspace", matchOnDescription: true, ignoreFocusOut: true },
  );
  return picked?.ws;
}

/** Fallback when the workspaces endpoint is unreachable: let the user paste the id by hand. */
async function enterWorkspaceIdManually(session: SessionStore, cause?: unknown): Promise<void> {
  const reason = cause instanceof Error ? ` (${cause.message})` : "";
  const input = await vscode.window.showInputBox({
    title: "Cloud.ru workspace",
    prompt: `Could not load the workspace list${reason}. Paste your workspace id (x-workspace-id).`,
    value: session.get()?.workspaceId ?? "",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : "Workspace id is required"),
  });
  const id = input?.trim();
  if (!id) return;
  await session.set({ workspaceId: id, workspaceName: id });
  void vscode.window.showInformationMessage(`Cloud.ru workspace: ${id}`);
}

/** Poll the notebook list until `isDone(status)`, refreshing the tree, with a progress notification. */
async function pollUntil(
  client: ConsoleApiClient,
  ws: WorkspaceContext,
  uid: string,
  tree: NotebooksTreeProvider,
  isDone: (status: string) => boolean,
  title: string,
  timeoutMs: number,
): Promise<void> {
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      tree.refresh();
      let notebooks: Awaited<ReturnType<ConsoleApiClient["listNotebooks"]>> | undefined;
      try {
        notebooks = await client.listNotebooks(ws);
      } catch {
        // transient; keep polling
      }
      const nb = notebooks?.find((n) => n.uid === uid);
      if (nb && isDone(nb.status)) {
        tree.refresh();
        return;
      }
      await delay(3000);
    }
    tree.refresh();
  });
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
async function withErrorHandling(
  auth: ConsoleTokenProvider,
  logger: Logger,
  body: (...args: unknown[]) => Promise<void>,
  ...args: unknown[]
): Promise<void> {
  try {
    await body(...args);
  } catch (err) {
    if (err instanceof ApiError) {
      logger.error("Command failed", err);
      void vscode.window.showErrorMessage(err.message);
      if (err.isAuth) await auth.signOut();
      return;
    }
    logger.error("Unexpected command error", err);
    void vscode.window.showErrorMessage(`Cloud.ru: ${String(err)}`);
  }
}
