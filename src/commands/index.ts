import * as vscode from "vscode";
import { ApiError } from "../api/errors";
import type { ConsoleTokenProvider } from "../console/tokenProvider";
import type { SessionStore } from "../session/sessionStore";
import type { Logger } from "../util/logger";
import type { NotebookTreeItem, NotebooksTreeProvider } from "../views/notebooksTree";
import type { NotebookViewController } from "../jupyter/notebookController";
import type { SshController } from "../ssh/sshController";

export interface CommandDeps {
  auth: ConsoleTokenProvider;
  session: SessionStore;
  tree: NotebooksTreeProvider;
  notebooks: NotebookViewController;
  ssh: SshController;
  logger: Logger;
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const { auth, session, tree, notebooks, ssh, logger } = deps;

  const run = (id: string, body: (...args: unknown[]) => Promise<void>): vscode.Disposable =>
    vscode.commands.registerCommand(id, (...args: unknown[]) => withErrorHandling(auth, logger, body, ...args));

  return [
    run("cloudru.signIn", async () => {
      const ok = await auth.signIn();
      if (!ok) return;
      if (!session.get()) await selectWorkspace(session);
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
      await selectWorkspace(session);
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

/** Console mode: capture the workspace id (x-workspace-id) and persist it. */
async function selectWorkspace(session: SessionStore): Promise<void> {
  const current = session.get();
  const input = await vscode.window.showInputBox({
    title: "Cloud.ru workspace",
    prompt: "Paste your workspace id (x-workspace-id) — from the console URL or developer params.",
    value: current?.workspaceId ?? "",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : "Workspace id is required"),
  });
  const id = input?.trim();
  if (!id) return;
  await session.set({ workspaceId: id, workspaceName: id });
  void vscode.window.showInformationMessage(`Cloud.ru workspace: ${id}`);
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
