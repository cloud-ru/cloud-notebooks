import * as vscode from "vscode";
import { ApiError } from "../api/errors";
import type { NotebookHandlerResponse, WorkspaceContext } from "../api/types";
import type { ConsoleApiClient, ConsoleWorkspace } from "../console/apiClient";
import { ConsoleTokenProvider, NotSignedInError } from "../console/tokenProvider";
import { buildResumeBody, splitImageRef, type ResumeBody } from "../console/resumeBody";
import { pollNotebookStatus, type PollOutcome } from "../console/pollLoop";
import type { SessionStore } from "../session/sessionStore";
import type { Logger } from "../util/logger";
import type { NotebookTreeItem, NotebooksTreeProvider } from "../views/notebooksTree";
import { buildNotebookActions } from "../views/notebookActions";
import type { NotebookViewController } from "../jupyter/notebookController";
import type { CloudruServerProvider } from "../jupyter/serverProvider";
import type { SshController } from "../ssh/sshController";

export interface CommandDeps {
  auth: ConsoleTokenProvider;
  client: ConsoleApiClient;
  session: SessionStore;
  tree: NotebooksTreeProvider;
  notebooks: NotebookViewController;
  serverProvider: CloudruServerProvider;
  ssh: SshController;
  logger: Logger;
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const { auth, client, session, tree, notebooks, serverProvider, ssh, logger } = deps;

  const run = (id: string, body: (...args: unknown[]) => Promise<void>): vscode.Disposable =>
    vscode.commands.registerCommand(id, (...args: unknown[]) => withErrorHandling(auth, logger, body, ...args));

  // After a lifecycle transition the pod is recreated, so any cached SSH tunnel / shim for it is dead.
  const invalidateTunnels = (uid: string): void => {
    notebooks.invalidate(uid);
    serverProvider.invalidate(uid);
  };

  return [
    run("cloudru.signIn", async () => {
      const ok = await auth.signIn();
      if (!ok) return;
      if (!session.get()) await selectWorkspace(client, session, logger);
      const ws = session.get();
      if (ws) void refreshPreflightWarning(client, ws, tree);
      tree.refresh();
    }),

    run("cloudru.signOut", async () => {
      await auth.signOut();
      await session.clear();
      tree.setPreflightWarning(undefined);
      tree.refresh();
    }),

    run("cloudru.selectWorkspace", async () => {
      if (!(await auth.isSignedIn())) {
        void vscode.window.showWarningMessage("Сначала войдите в Cloud.ru.");
        return;
      }
      await selectWorkspace(client, session, logger);
      const ws = session.get();
      if (ws) void refreshPreflightWarning(client, ws, tree);
      tree.refresh();
    }),

    run("cloudru.refreshNotebooks", async () => {
      tree.refresh();
    }),

    run("cloudru.statusBarMenu", async () => {
      if (!(await auth.isSignedIn())) {
        await vscode.commands.executeCommand("cloudru.signIn");
        return;
      }
      const CHANGE = "Сменить воркспейс…";
      const REFRESH = "Обновить список";
      const OUT = "Выйти";
      const picked = await vscode.window.showQuickPick([CHANGE, REFRESH, OUT], { title: "Cloud.ru ML Space" });
      if (picked === CHANGE) await vscode.commands.executeCommand("cloudru.selectWorkspace");
      else if (picked === REFRESH) await vscode.commands.executeCommand("cloudru.refreshNotebooks");
      else if (picked === OUT) await vscode.commands.executeCommand("cloudru.signOut");
    }),

    run("cloudru.searchNotebooks", async () => {
      const query = await vscode.window.showInputBox({
        title: "Поиск ноутбуков по имени",
        prompt: "Введите часть имени ноутбука (пусто — сбросить).",
        ignoreFocusOut: true,
      });
      if (query === undefined) return; // cancelled — keep current filter
      tree.setSearch(query);
    }),

    run("cloudru.filterByAuthor", async () => {
      const authors = tree.authors();
      if (authors.length === 0) {
        void vscode.window.showInformationMessage("Ноутбуки ещё не загружены — фильтровать по автору нечего.");
        return;
      }
      const ALL = "Все авторы";
      const picked = await vscode.window.showQuickPick([ALL, ...authors], {
        title: "Фильтр ноутбуков по автору",
        ignoreFocusOut: true,
      });
      if (picked === undefined) return;
      tree.setAuthor(picked === ALL ? undefined : picked);
    }),

    run("cloudru.filterByStatus", async () => {
      const items = tree.statusFilterItems();
      if (items.length === 0) {
        void vscode.window.showInformationMessage("Ноутбуки ещё не загружены — фильтровать по статусу нечего.");
        return;
      }
      const active = new Set(tree.currentStatuses());
      const picked = await vscode.window.showQuickPick(
        items.map((it) => ({ label: `${it.label} (${it.count})`, status: it.status, picked: active.has(it.status) })),
        {
          title: "Фильтр ноутбуков по статусу",
          canPickMany: true,
          ignoreFocusOut: true,
        },
      );
      if (picked === undefined) return; // cancelled — keep current filter
      tree.setStatuses(picked.map((p) => p.status));
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

    run("cloudru.notebookActions", async (...args: unknown[]) => {
      const item = args[0] as NotebookTreeItem | undefined;
      if (!item) return;
      const actions = buildNotebookActions(item.notebook, tree.isFavorite(item.notebook.uid));
      const picked = await vscode.window.showQuickPick(
        actions.map((a) => ({ label: a.label, description: a.description, command: a.command })),
        { title: `«${item.notebook.name}» — действия`, ignoreFocusOut: true },
      );
      if (!picked?.command) return; // disabled item (no command) or cancelled
      await vscode.commands.executeCommand(picked.command, item);
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
      const { name, uid } = item.notebook;
      await client.pauseNotebook(ws, uid);
      const outcome = await pollUntil(client, ws, uid, tree, {
        title: `Остановка «${name}»…`,
        timeoutMs: 120_000,
        isComplete: (nb) => nb?.status.startsWith("paused") ?? false,
        isFailed: (nb) => nb?.status === "error",
        timeoutMessage: `«${name}»: остановка занимает дольше обычного — обновите список позже.`,
      });
      invalidateTunnels(uid);
      if (outcome.kind === "failed") {
        void vscode.window.showErrorMessage(`Не удалось остановить «${name}».`);
      }
    }),

    run("cloudru.resumeNotebook", async (...args: unknown[]) => {
      const item = args[0] as NotebookTreeItem | undefined;
      const ws = session.get();
      if (!item || !ws) return;
      const { name, uid } = item.notebook;
      // The resume endpoint is keyed by the workspace's k8s namespace. Prefer the workspace
      // namespace (reliably returned by /user/v1/workspaces/); the per-notebook namespace is a
      // fallback for the manual-id path where the workspace list was unavailable.
      const namespace = ws.namespace ?? item.notebook.namespace;
      if (!namespace) {
        void vscode.window.showErrorMessage(
          `Не удалось запустить «${name}»: неизвестен namespace воркспейса. Выполните «Cloud.ru: Выбрать воркспейс» и повторите.`,
        );
        return;
      }
      if (!(await isProjectActive(client, ws))) {
        void vscode.window.showErrorMessage(
          "Не хватает средств или прав для создания и подключения Jupyter Server.",
        );
        return;
      }
      await client.resumeNotebook(ws, namespace, await resolveResumeBody(client, ws, item.notebook));
      const outcome = await pollUntil(client, ws, uid, tree, {
        title: `Запуск «${name}»…`,
        timeoutMs: 300_000,
        isComplete: (nb) => nb?.status === "running",
        isFailed: (nb) => nb?.status === "error" || nb?.status === "rejected",
        timeoutMessage: `«${name}»: запуск занимает дольше обычного — обновите список позже.`,
      });
      invalidateTunnels(uid);
      if (outcome.kind === "failed") {
        const LOGS = "Показать логи";
        const choice = await vscode.window.showErrorMessage(`Не удалось запустить «${name}».`, LOGS);
        if (choice === LOGS) await showNotebookLogs(client, ws, item.notebook);
      }
    }),

    run("cloudru.configureSsh", async () => {
      await ssh.configure();
    }),

    run("cloudru.openNotebookInBrowser", async (...args: unknown[]) => {
      const item = args[0] as NotebookTreeItem | undefined;
      const url = item?.notebook.url;
      if (!url) {
        void vscode.window.showWarningMessage("У ноутбука ещё нет URL — он должен быть запущен.");
        return;
      }
      const TREE = "Открыть Jupyter (tree)";
      const LAB = "Открыть JupyterLab";
      const choice = await vscode.window.showQuickPick(
        [
          { label: TREE, description: "Классический интерфейс Jupyter" },
          { label: LAB, description: "JupyterLab" },
        ],
        { title: `Открыть «${item.notebook.name}» в браузере`, ignoreFocusOut: true },
      );
      if (!choice) return;
      const ws = session.get();
      const base = url.endsWith("/") ? url : `${url}/`;
      const page = choice.label === LAB ? "lab" : "tree";
      const suffix = ws ? `?ws=${encodeURIComponent(ws.workspaceId)}` : "";
      await vscode.env.openExternal(vscode.Uri.parse(`${base}${page}/${suffix}`));
    }),

    run("cloudru.showLogs", async (...args: unknown[]) => {
      const item = args[0] as NotebookTreeItem | undefined;
      const ws = session.get();
      if (!item || !ws) return;
      await showNotebookLogs(client, ws, item.notebook);
    }),

    run("cloudru.deleteNotebook", async (...args: unknown[]) => {
      const item = args[0] as NotebookTreeItem | undefined;
      const ws = session.get();
      if (!item || !ws) return;
      const { name, uid } = item.notebook;
      const CONFIRM = "Удалить";
      const choice = await vscode.window.showWarningMessage(
        `«${name}» будет удален без возможности восстановления.`,
        { modal: true },
        CONFIRM,
      );
      if (choice !== CONFIRM) return;
      await client.deleteNotebook(ws, uid);
      invalidateTunnels(uid);
      await pollUntil(client, ws, uid, tree, {
        title: `Удаление «${name}»…`,
        timeoutMs: 120_000,
        isComplete: (nb) => nb === undefined || nb.status === "deleted",
        timeoutMessage: `«${name}»: удаление занимает дольше обычного — обновите список позже.`,
      });
    }),

    run("cloudru.generateSshKey", async () => {
      const CONFIRM = "Сгенерировать";
      const choice = await vscode.window.showWarningMessage(
        "При генерации нового или загрузке ключа из файла старый перестанет работать.",
        { modal: true },
        CONFIRM,
      );
      if (choice !== CONFIRM) return;
      await ssh.generateKey();
    }),

    run("cloudru.openMonitoring", async () => {
      await vscode.env.openExternal(vscode.Uri.parse(consoleWebUrl()));
    }),

    run("cloudru.createNotebookInConsole", async () => {
      await vscode.env.openExternal(vscode.Uri.parse(consoleWebUrl()));
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
      { location: vscode.ProgressLocation.Notification, title: "Загрузка воркспейсов Cloud.ru…" },
      () => client.listWorkspaces(),
    );
  } catch (err) {
    if (err instanceof NotSignedInError) throw err; // expired session → single re-auth path, no manual id
    logger.error("Failed to load Cloud.ru workspaces", err);
    await enterWorkspaceIdManually(session, err);
    return;
  }
  if (workspaces.length === 0) {
    void vscode.window.showWarningMessage("Для этого аккаунта нет доступных воркспейсов Cloud.ru.");
    return;
  }

  const chosen = workspaces.length === 1 ? workspaces[0] : await pickWorkspace(workspaces);
  if (!chosen) return;
  await session.set({
    workspaceId: chosen.workspace_id,
    workspaceName: chosen.workspace_name,
    ...(chosen.namespace ? { namespace: chosen.namespace } : {}),
  });
  logger.info(
    `[ws] selected "${chosen.workspace_name}" (id=${chosen.workspace_id}, namespace=${chosen.namespace ?? "—"}); ` +
      `fields: ${Object.keys(chosen).join(", ")}`,
  );
  void vscode.window.showInformationMessage(`Воркспейс Cloud.ru: ${chosen.workspace_name}`);
}

async function pickWorkspace(workspaces: ConsoleWorkspace[]): Promise<ConsoleWorkspace | undefined> {
  const picked = await vscode.window.showQuickPick(
    workspaces.map((ws) => ({
      label: ws.workspace_name,
      ...(ws.project_name ? { description: ws.project_name } : {}),
      ...(ws.email ? { detail: ws.email } : {}),
      ws,
    })),
    { title: "Выберите воркспейс Cloud.ru", matchOnDescription: true, ignoreFocusOut: true },
  );
  return picked?.ws;
}

/** Fallback when the workspaces endpoint is unreachable: let the user paste the id by hand. */
async function enterWorkspaceIdManually(session: SessionStore, cause?: unknown): Promise<void> {
  const reason = cause instanceof Error ? ` (${cause.message})` : "";
  const input = await vscode.window.showInputBox({
    title: "Воркспейс Cloud.ru",
    prompt: `Не удалось загрузить список воркспейсов${reason}. Вставьте id воркспейса (x-workspace-id).`,
    value: session.get()?.workspaceId ?? "",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : "Нужен id воркспейса"),
  });
  const id = input?.trim();
  if (!id) return;
  await session.set({ workspaceId: id, workspaceName: id });
  void vscode.window.showInformationMessage(`Воркспейс Cloud.ru: ${id}`);
}

/**
 * Build the resume body, looking up harbor image labels via docker_images the way the web app does
 * (2.4). Artifact-registry images need no lookup; any lookup failure falls back to empty labels so a
 * transient error never blocks a resume.
 */
async function resolveResumeBody(
  client: ConsoleApiClient,
  ws: WorkspaceContext,
  notebook: NotebookHandlerResponse,
): Promise<ResumeBody> {
  if (notebook.imageSource === "artifact_registry") return buildResumeBody(notebook);
  const { name, tag } = splitImageRef(notebook.image || "");
  try {
    const resolved = await client.findResumeImage(ws, { region: notebook.region, imageName: name, tag });
    return buildResumeBody(notebook, resolved);
  } catch {
    return buildResumeBody(notebook);
  }
}

/** Base console URL for "open in console" actions (create / monitoring). */
function consoleWebUrl(): string {
  return vscode.workspace.getConfiguration("cloudru").get<string>("console.url", "https://console.cloud.ru/");
}

/** Open the notebook's logs (plus status/reason header) as a read-only log document. */
async function showNotebookLogs(
  client: ConsoleApiClient,
  ws: WorkspaceContext,
  notebook: NotebookHandlerResponse,
): Promise<void> {
  const namespace = ws.namespace ?? notebook.namespace;
  if (!namespace) {
    void vscode.window.showErrorMessage(
      `Не удалось получить логи «${notebook.name}»: неизвестен namespace воркспейса.`,
    );
    return;
  }
  const logs = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Загрузка логов «${notebook.name}»…` },
    () => client.getNotebookLogs(ws, namespace, notebook.name, notebook.region),
  );
  const header =
    `# ${notebook.name}\n` +
    `# status: ${logs.notebook_status || "—"}, reason: ${logs.status_reason || "—"}\n\n`;
  const doc = await vscode.workspace.openTextDocument({
    content: header + (logs.logs || "(логи пусты)"),
    language: "log",
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

/** Project preflight; treats any failure as active so a flaky preflight never blocks the user. */
async function isProjectActive(client: ConsoleApiClient, ws: WorkspaceContext): Promise<boolean> {
  try {
    return (await client.getProjectStatus(ws)).access;
  } catch {
    return true;
  }
}

/** Refresh the tree's preflight warning line for the current workspace. */
async function refreshPreflightWarning(
  client: ConsoleApiClient,
  ws: WorkspaceContext,
  tree: NotebooksTreeProvider,
): Promise<void> {
  const active = await isProjectActive(client, ws);
  tree.setPreflightWarning(
    active ? undefined : "Проект приостановлен: не хватает средств или прав для создания и подключения Jupyter Server.",
  );
}
interface PollUntilOptions {
  title: string;
  timeoutMs: number;
  isComplete: (nb: NotebookHandlerResponse | undefined) => boolean;
  isFailed?: (nb: NotebookHandlerResponse | undefined) => boolean;
  timeoutMessage: string;
}

/**
 * Poll a notebook's lifecycle transition under a cancellable progress notification, feeding each fresh
 * list straight to the tree (no blind refresh). Generic outcomes (cancel, session expiry, a run of
 * network errors, timeout) are handled here; `done`/`failed` are returned so the caller can toast the
 * operation-specific message. The server operation keeps running if the user cancels the progress.
 */
async function pollUntil(
  client: ConsoleApiClient,
  ws: WorkspaceContext,
  uid: string,
  tree: NotebooksTreeProvider,
  opts: PollUntilOptions,
): Promise<PollOutcome> {
  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: opts.title, cancellable: true },
    (_progress, token) =>
      pollNotebookStatus({
        list: () => client.listNotebooks(ws),
        uid,
        isComplete: opts.isComplete,
        ...(opts.isFailed ? { isFailed: opts.isFailed } : {}),
        onNotebooks: (list) => tree.applyNotebooks(list),
        isCancelled: () => token.isCancellationRequested,
        isSignedOutError: (err) => err instanceof NotSignedInError,
        timeoutMs: opts.timeoutMs,
      }),
  );
  tree.refresh();
  if (outcome.kind === "networkErrors") {
    const detail = outcome.error instanceof ApiError ? outcome.error.message : String(outcome.error);
    void vscode.window.showErrorMessage(`Cloud.ru: потеряна связь при отслеживании статуса. ${detail}`);
  } else if (outcome.kind === "timeout") {
    void vscode.window.showWarningMessage(opts.timeoutMessage);
  }
  return outcome;
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
    if (err instanceof NotSignedInError) return; // provider already flipped auth + prompted re-auth
    if (err instanceof ApiError) {
      logger.error("Command failed", err);
      if (err.isAuth) {
        await auth.handleExpiredSession(); // single expiry path: one "Войти" toast (H7)
        return;
      }
      if (err.kind === "network") {
        const RETRY = "Повторить";
        const choice = await vscode.window.showErrorMessage(err.message, RETRY);
        if (choice === RETRY) await withErrorHandling(auth, logger, body, ...args);
        return;
      }
      void vscode.window.showErrorMessage(err.message);
      return;
    }
    logger.error("Unexpected command error", err);
    void vscode.window.showErrorMessage(`Cloud.ru: ${String(err)}`);
  }
}
