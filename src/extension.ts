import * as vscode from "vscode";
import { MlSpaceApiClient } from "./api/mlspaceClient";
import { AuthService } from "./auth/authService";
import { registerCommands } from "./commands";
import { SessionStore } from "./session/sessionStore";
import { Logger } from "./util/logger";
import { NotebooksTreeProvider } from "./views/notebooksTree";
import { NotebookViewController } from "./jupyter/notebookController";
import { CloudruSshFsProvider, SSH_SCHEME } from "./ssh/sftpFs";
import { SshController } from "./ssh/sshController";

const AUTH_CONTEXT_KEY = "cloudru.authenticated";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new Logger();
  context.subscriptions.push(logger);

  const baseUrl = vscode.workspace
    .getConfiguration("cloudru")
    .get<string>("api.baseUrl", "https://api.ai.cloud.ru");

  // Wire AuthService <-> client. `auth` is referenced lazily inside getToken, so the
  // declaration order is fine: getToken only runs after activation completes.
  let auth: AuthService;
  const client = new MlSpaceApiClient({ baseUrl, getToken: () => auth.getAccessToken() });
  auth = new AuthService({
    secrets: context.secrets,
    logger,
    exchange: (creds) => client.authenticate(creds),
  });
  context.subscriptions.push(auth);

  const session = new SessionStore(context.secrets);
  context.subscriptions.push(session);
  await session.restore();

  const tree = new NotebooksTreeProvider({
    client,
    session,
    isSignedIn: () => auth.isSignedIn(),
    logger,
  });
  context.subscriptions.push(tree);
  context.subscriptions.push(
    vscode.window.createTreeView("cloudruNotebooks", { treeDataProvider: tree }),
  );

  const notebooks = new NotebookViewController({ secrets: context.secrets, context, logger });
  context.subscriptions.push(notebooks);

  const sshFs = new CloudruSshFsProvider();
  context.subscriptions.push(sshFs);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SSH_SCHEME, sshFs, { isCaseSensitive: true }),
  );
  const ssh = new SshController({ provider: sshFs, context, logger });

  context.subscriptions.push(...registerCommands({ auth, client, session, tree, notebooks, ssh, logger }));

  // Keep the `when`-context and the tree in sync with auth/workspace changes.
  await setAuthenticatedContext(await auth.isSignedIn());
  context.subscriptions.push(
    auth.onDidChangeAuth(async (signedIn) => {
      await setAuthenticatedContext(signedIn);
      tree.refresh();
    }),
    session.onDidChangeWorkspace(() => tree.refresh()),
  );

  logger.info("Cloud.ru ML Space extension activated.");
}

export function deactivate(): void {
  // Disposables are handled via context.subscriptions.
}

async function setAuthenticatedContext(value: boolean): Promise<void> {
  await vscode.commands.executeCommand("setContext", AUTH_CONTEXT_KEY, value);
}
