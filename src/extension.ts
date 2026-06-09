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
    getToken: () => auth.getAccessToken(),
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

  const notebooks = new NotebookViewController({ secrets: context.secrets, context, logger });
  context.subscriptions.push(notebooks);

  const sshConfig = new SshConfig(context);
  const sshFs = new CloudruSshFsProvider((uid) => sshConfig.resolveSilently(uid));
  context.subscriptions.push(sshFs);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SSH_SCHEME, sshFs, { isCaseSensitive: true }),
  );
  const ssh = new SshController({ provider: sshFs, config: sshConfig, context, logger });

  // Remote kernel (Colab-style): contribute notebooks as Jupyter servers tunneled over SSH.
  const serverProvider = new CloudruServerProvider({
    config: sshConfig,
    getRunningNotebooks: async () => {
      const ws = session.get();
      if (!ws || !(await auth.isSignedIn())) return [];
      return client.listNotebooks(ws);
    },
    logger,
  });
  context.subscriptions.push(serverProvider);
  await registerJupyterServerCollection(context, serverProvider, logger);

  context.subscriptions.push(...registerCommands({ auth, session, tree, notebooks, ssh, logger }));

  // Keep the `when`-context, the tree, and the kernel servers in sync with auth/workspace changes.
  await setAuthenticatedContext(await auth.isSignedIn());
  context.subscriptions.push(
    auth.onDidChangeAuth(async (signedIn) => {
      await setAuthenticatedContext(signedIn);
      tree.refresh();
      serverProvider.refresh();
    }),
    session.onDidChangeWorkspace(() => {
      tree.refresh();
      serverProvider.refresh();
    }),
  );

  logger.info("Cloud.ru ML Space extension activated.");
}

export function deactivate(): void {
  // Disposables are handled via context.subscriptions.
}

async function setAuthenticatedContext(value: boolean): Promise<void> {
  await vscode.commands.executeCommand("setContext", AUTH_CONTEXT_KEY, value);
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
    const collection = api.createJupyterServerCollection("cloudru-mlspace", "Cloud.ru ML Space", provider);
    context.subscriptions.push(collection);
  } catch (err) {
    logger.error("Failed to register the Cloud.ru Jupyter server collection", err);
  }
}
