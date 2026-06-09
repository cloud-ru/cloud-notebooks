import * as vscode from "vscode";
import { ApiError } from "../api/errors";
import type { MlSpaceApiClient } from "../api/mlspaceClient";
import type { Workspace, WorkspaceContext } from "../api/types";
import type { AuthService } from "../auth/authService";
import type { SessionStore } from "../session/sessionStore";
import type { Logger } from "../util/logger";
import type { NotebookTreeItem, NotebooksTreeProvider } from "../views/notebooksTree";
import type { NotebookViewController } from "../jupyter/notebookController";
import type { SshController } from "../ssh/sshController";

export interface CommandDeps {
  auth: AuthService;
  client: MlSpaceApiClient;
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
      if (!session.get()) await selectWorkspace(client, session);
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
      await selectWorkspace(client, session);
      tree.refresh();
    }),

    run("cloudru.refreshNotebooks", async () => {
      tree.refresh();
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

/** Workspace picker: list workspaces, resolve x-api-key, persist the selection. */
async function selectWorkspace(client: MlSpaceApiClient, session: SessionStore): Promise<void> {
  const workspaces = await client.listWorkspaces();
  if (workspaces.length === 0) {
    void vscode.window.showWarningMessage("No Cloud.ru workspaces are available for this account.");
    return;
  }

  const chosen =
    workspaces.length === 1
      ? workspaces[0]
      : await pickWorkspace(workspaces);
  if (!chosen) return;

  const xApiKey = await resolveXApiKey(client, chosen.id);
  if (!xApiKey) return;

  const ctx: WorkspaceContext = {
    workspaceId: chosen.id,
    namespace: chosen.namespace,
    xApiKey,
    workspaceName: chosen.name,
  };
  await session.set(ctx);
  void vscode.window.showInformationMessage(`Cloud.ru workspace: ${chosen.name}`);
}

async function pickWorkspace(workspaces: Workspace[]): Promise<Workspace | undefined> {
  const picked = await vscode.window.showQuickPick(
    workspaces.map((ws) => ({
      label: ws.name,
      description: ws.project_name,
      detail: ws.owner_email,
      ws,
    })),
    { title: "Select Cloud.ru workspace", ignoreFocusOut: true },
  );
  return picked?.ws;
}

/** Fetch the workspace x-api-key, falling back to manual entry if the endpoint is unavailable. */
async function resolveXApiKey(client: MlSpaceApiClient, workspaceId: string): Promise<string | undefined> {
  try {
    return await client.getXApiKey(workspaceId);
  } catch {
    return vscode.window.showInputBox({
      title: "Cloud.ru x-api-key",
      prompt: "Could not fetch the x-api-key automatically. Paste the workspace API key.",
      password: true,
      ignoreFocusOut: true,
    });
  }
}

async function withErrorHandling(
  auth: AuthService,
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
