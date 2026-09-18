import * as vscode from "vscode";
import { ConsoleApiClient } from "./console/apiClient";
import { ConsoleTokenProvider } from "./console/tokenProvider";
import { registerCommands } from "./commands";
import { SessionStore } from "./session/sessionStore";
import { Logger } from "./util/logger";
import { NotebooksTreeProvider } from "./views/notebooksTree";
import { FavoritesStore } from "./views/favoritesStore";
import { NotebookViewController } from "./jupyter/notebookController";
import { CloudruSshFsProvider, SSH_SCHEME } from "./ssh/sftpFs";
import { SshController } from "./ssh/sshController";
import { SshConfig } from "./ssh/sshConfig";
import { CloudruServerProvider } from "./jupyter/serverProvider";
import { CloudruStatusBar } from "./views/statusBar";
import { AutoRefresh } from "./views/autoRefresh";
import type { Jupyter } from "@vscode/jupyter-extension";

const AUTH_CONTEXT_KEY = "cloudru.authenticated";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new Logger();
  context.subscriptions.push(logger);

  const consoleBaseUrl = vscode.workspace
    .getConfiguration("cloudru")
    .get<string>("console.apiBaseUrl", "https://console.cloud.ru/aicloud/ui");

  const auth = new ConsoleTokenProvider({ context, logger });
  context.subscriptions.push(auth);
  const client = new ConsoleApiClient({
    baseUrl: consoleBaseUrl,
    getToken: (forceRefresh) => auth.getAccessToken(forceRefresh),
    onAuthFailure: () => auth.handleExpiredSession(),
    logger,
  });

  const session = new SessionStore(context.secrets);
  context.subscriptions.push(session);
  await session.restore();

  const favorites = new FavoritesStore(context.globalState);
  const tree = new NotebooksTreeProvider({
    client,
    session,
    favorites,
    isSignedIn: () => auth.isSignedIn(),
    logger,
  });
  context.subscriptions.push(tree);
  const notebooksView = vscode.window.createTreeView("cloudruNotebooks", { treeDataProvider: tree });
  context.subscriptions.push(notebooksView);
  tree.attachView(notebooksView);

  const sshConfig = new SshConfig(context, {
    client, getWorkspace: () => session.get(), getGeneration: () => session.getGeneration(),
    isSignedIn: () => auth.isSignedIn(), logger,
  });

  const notebooks = new NotebookViewController({ config: sshConfig, logger });
  context.subscriptions.push(notebooks);

  const sshFs = new CloudruSshFsProvider((uid) => sshConfig.resolveSilently(uid));
  context.subscriptions.push(sshFs);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SSH_SCHEME, sshFs, { isCaseSensitive: true }),
  );
  const ssh = new SshController({ provider: sshFs, config: sshConfig, context, logger, getGeneration: () => session.getGeneration() });

  // Remote kernel (Colab-style): contribute notebooks as Jupyter servers tunneled over SSH.
  const serverProvider = new CloudruServerProvider({
    config: sshConfig,
    getRunningNotebooks: async () => {
      const ws = session.get();
      const generation = session.getGeneration();
      if (!ws || !(await auth.isSignedIn())) return [];
      if (generation !== session.getGeneration()) return [];
      const notebooks = await client.listNotebooks(ws);
      return generation === session.getGeneration() ? notebooks : [];
    },
    logger,
  });
  context.subscriptions.push(serverProvider);
  await registerJupyterServerCollection(context, serverProvider, logger);

  const statusBar = new CloudruStatusBar({
    isSignedIn: () => auth.isSignedIn(),
    getWorkspace: () => session.get(),
  });
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    ...registerCommands({ auth, client, session, tree, notebooks, serverProvider, ssh, logger }),
  );

  // Keep the `when`-contexts, the tree, the status bar, and the kernel servers in sync.
  await syncContexts(await auth.isSignedIn(), auth.sessionExpired, Boolean(session.get()));
  await statusBar.refresh();
  if (session.get() && await auth.isSignedIn()) {
    void vscode.commands.executeCommand("cloudru.refreshNotebooks");
  }
  context.subscriptions.push(
    auth.onDidChangeAuth(async (signedIn) => {
      client.invalidateContext();
      session.invalidateAuthContext();
      tree.resetContext();
      await syncContexts(signedIn, auth.sessionExpired, Boolean(session.get()));
      if (!signedIn) {
        // Signed out: every tunnel/shim/panel belongs to a session we can no longer reach.
        notebooks.disposeAll();
        serverProvider.disposeAll();
        sshFs.reset();
      }
      await statusBar.refresh();
      tree.refresh();
      serverProvider.refresh();
    }),
    session.onDidChangeWorkspace(async () => {
      client.invalidateContext();
      tree.resetContext();
      // Switching workspace: the cached tunnels point at the previous workspace's notebooks.
      notebooks.disposeAll();
      serverProvider.disposeAll();
      sshFs.reset();
      await syncContexts(await auth.isSignedIn(), auth.sessionExpired, Boolean(session.get()));
      await statusBar.refresh();
      tree.refresh();
      serverProvider.refresh();
    }),
  );
  context.subscriptions.push(
    auth.onDidChangeMinting((active) =>
      tree.setSignInMessage(active ? "Выполняется вход в Cloud.ru…" : undefined),
    ),
  );

  const autoRefresh = new AutoRefresh({
    isActive: async () => (await auth.isSignedIn()) && Boolean(session.get()),
    hasBusy: () => tree.hasBusyNotebooks(),
    refresh: () => {
      tree.refresh();
      serverProvider.refresh();
    },
  });
  context.subscriptions.push(autoRefresh);
  autoRefresh.start();

  logger.info("Cloud.ru Distributed Train extension activated.");
}

export function deactivate(): void {
  // Disposables are handled via context.subscriptions.
}

async function syncContexts(signedIn: boolean, sessionExpired: boolean, workspaceSelected: boolean): Promise<void> {
  await vscode.commands.executeCommand("setContext", AUTH_CONTEXT_KEY, signedIn);
  await vscode.commands.executeCommand("setContext", "cloudru.sessionExpired", sessionExpired);
  await vscode.commands.executeCommand("setContext", "cloudru.workspaceSelected", workspaceSelected);
}

async function registerJupyterServerCollection(
  context: vscode.ExtensionContext,
  provider: CloudruServerProvider,
  logger: Logger,
): Promise<void> {
  const extension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
  if (!extension) {
    logger.warn("ms-toolsai.jupyter is not installed; remote kernels are unavailable.");
    return;
  }
  try {
    const api = extension.isActive ? extension.exports : await extension.activate();
    const collection = api.createJupyterServerCollection("cloudru-mlspace", "Cloud.ru Distributed Train", provider);
    context.subscriptions.push(collection);
  } catch (err) {
    logger.error("Failed to register the Cloud.ru Jupyter server collection", err);
  }
}
