import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ApiError } from "../api/errors";
import type { NotebookHandlerResponse, WorkspaceContext } from "../api/types";
import type { ConsoleApiClient, ConsoleWorkspace } from "../console/apiClient";
import { ConsoleTokenProvider, NotSignedInError } from "../console/tokenProvider";
import { isoDaysAgo } from "../console/logsFile";
import { buildResumeBody, splitImageRef, type ResumeBody } from "../console/resumeBody";
import { pollNotebookStatus, type PollOutcome } from "../console/pollLoop";
import type { SessionStore } from "../session/sessionStore";
import type { Logger } from "../util/logger";
import { NotebookTreeItem, type NotebooksTreeProvider } from "../views/notebooksTree";
import { buildNotebookActions } from "../views/notebookActions";
import type { NotebookViewController } from "../jupyter/notebookController";
import type { CloudruServerProvider } from "../jupyter/serverProvider";
import { toAbsoluteNotebookUrl } from "../jupyter/notebookUrl";
import type { SshController } from "../ssh/sshController";

/** Description length cap enforced by the console's edit form. */
const MAX_DESCRIPTION_LENGTH = 64;

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
  const activeOperations = new Set<string>();
  const retryableReads: Record<string, true> = {
    "cloudru.selectWorkspace": true, "cloudru.showLogs": true, "cloudru.downloadLogs": true,
  };
  const itemCommands: Record<string, true> = {
    "cloudru.openNotebook": true, "cloudru.openNotebookInBrowser": true, "cloudru.resumeNotebook": true, "cloudru.pauseNotebook": true,
    "cloudru.openNotebookFiles": true, "cloudru.openFullIde": true, "cloudru.showLogs": true, "cloudru.downloadLogs": true,
    "cloudru.editDescription": true, "cloudru.deleteNotebook": true,
    "cloudru.addFavorite": true, "cloudru.removeFavorite": true, "cloudru.notebookActions": true,
  };

  const run = (id: string, body: (...args: unknown[]) => Promise<void>): vscode.Disposable =>
    vscode.commands.registerCommand(id, (...args: unknown[]) => {
      const item = args[0] instanceof NotebookTreeItem ? args[0] : undefined;
      if (id in itemCommands && !item) {
        void vscode.window.showWarningMessage("Выберите ноутбук в списке Cloud.ru и повторите действие.");
        return;
      }
      if (item && item.contextGeneration !== session.getGeneration()) {
        void vscode.window.showWarningMessage("Список относится к прежнему воркспейсу. Обновите его и повторите действие.");
        return;
      }
      if (item && id !== "cloudru.notebookActions") {
        const action = buildNotebookActions(item.notebook, tree.isFavorite(item.notebook.uid))
          .find((candidate) => candidate.command === id);
        if (!action) {
          void vscode.window.showWarningMessage(`Действие сейчас недоступно для «${item.notebook.name}». Обновите список и проверьте статус и права.`);
          return;
        }
      }
      return withErrorHandling(auth, logger, id in retryableReads, body, ...args);
    });

  const withNotebookOperation = async (item: NotebookTreeItem, work: () => Promise<void>): Promise<void> => {
    const ws = session.get();
    if (!ws || item.contextGeneration !== session.getGeneration()) return;
    const key = JSON.stringify([item.contextGeneration, ws.workspaceId, item.notebook.uid]);
    if (activeOperations.has(key)) {
      void vscode.window.showInformationMessage(`Операция с «${item.notebook.name}» уже выполняется.`);
      return;
    }
    activeOperations.add(key);
    try {
      await work();
    } finally {
      activeOperations.delete(key);
    }
  };

  // After a lifecycle transition the pod is recreated, so any cached SSH tunnel / shim for it is dead.
  const invalidateTunnels = (uid: string): void => {
    notebooks.invalidate(uid);
    serverProvider.invalidate(uid);
    ssh.invalidate(uid);
  };

  return [
    run("cloudru.signIn", async () => {
      const ok = await auth.signIn();
      if (!ok) return;
      if (!session.get()) await selectWorkspace(client, session, logger);
      const ws = session.get();
      if (ws) void refreshPreflightWarning(client, ws, tree, session.getGeneration());
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
      if (ws) void refreshPreflightWarning(client, ws, tree, session.getGeneration());
      tree.refresh();
    }),

    run("cloudru.refreshNotebooks", async () => {
      tree.refresh();
      const ws = session.get();
      if (ws) void refreshPreflightWarning(client, ws, tree, session.getGeneration());
    }),

    run("cloudru.statusBarMenu", async () => {
      if (!(await auth.isSignedIn())) {
        await vscode.commands.executeCommand("cloudru.signIn");
        return;
      }
      const CHANGE = "Сменить воркспейс…";
      const REFRESH = "Обновить список";
      const OUT = "Выйти";
      const picked = await vscode.window.showQuickPick([CHANGE, REFRESH, OUT], { title: "Cloud.ru Distributed Train" });
      if (picked === CHANGE) await vscode.commands.executeCommand("cloudru.selectWorkspace");
      else if (picked === REFRESH) await vscode.commands.executeCommand("cloudru.refreshNotebooks");
      else if (picked === OUT) await vscode.commands.executeCommand("cloudru.signOut");
    }),

    run("cloudru.searchNotebooks", async () => {
      const query = await vscode.window.showInputBox({
        title: "Поиск ноутбуков по имени",
        prompt: "Введите часть имени ноутбука (пусто — сбросить).",
        value: tree.currentSearch(),
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
      await withNotebookOperation(item, async () => {
        const { name, uid } = item.notebook;
        const CONFIRM = "Остановить";
        const choice = await vscode.window.showWarningMessage(
          `Остановить «${name}»? Несохранённые данные вне NFS будут потеряны.`,
          { modal: true }, CONFIRM,
        );
        if (choice !== CONFIRM || item.contextGeneration !== session.getGeneration()) return;
        const submitted = await submitAndObserve(
          () => client.pauseNotebook(ws, uid),
          () => client.listNotebooks(ws),
          (nb) => nb?.status.startsWith("paused") ?? false,
          uid, item.contextGeneration, tree,
        );
        if (!submitted) return;
        const outcome = await pollUntil(client, ws, uid, tree, {
          title: `Ожидание остановки «${name}»…`,
          timeoutMs: 120_000,
          isComplete: (nb) => nb?.status.startsWith("paused") ?? false,
          isFailed: (nb) => nb?.status === "error" || nb?.status === "rejected",
          timeoutMessage: `«${name}»: остановка занимает дольше обычного — обновите список позже.`,
        }, item.contextGeneration);
        if (outcome.kind === "done") invalidateTunnels(uid);
        if (outcome.kind === "failed") void vscode.window.showErrorMessage(`Не удалось остановить «${name}».`);
      });
    }),

    run("cloudru.resumeNotebook", async (...args: unknown[]) => {
      const item = args[0] as NotebookTreeItem | undefined;
      const ws = session.get();
      if (!item || !ws) return;
      await withNotebookOperation(item, async () => {
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
      if (item.contextGeneration !== session.getGeneration()) return;
      const body = await resolveResumeBody(client, ws, item.notebook);
      if (item.contextGeneration !== session.getGeneration()) return;
      const submitted = await submitAndObserve(
        () => client.resumeNotebook(ws, namespace, body),
        () => client.listNotebooks(ws),
        (nb) => nb?.status === "running",
        uid, item.contextGeneration, tree,
      );
      if (!submitted) return;
      const outcome = await pollUntil(client, ws, uid, tree, {
        title: `Ожидание запуска «${name}»…`,
        timeoutMs: 300_000,
        isComplete: (nb) => nb?.status === "running",
        isFailed: (nb) => nb?.status === "error" || nb?.status === "rejected",
        timeoutMessage: `«${name}»: запуск занимает дольше обычного — обновите список позже.`,
      }, item.contextGeneration);
      if (outcome.kind === "done") invalidateTunnels(uid);
      if (outcome.kind === "failed") {
        const LOGS = "Показать логи";
        const choice = await vscode.window.showErrorMessage(`Не удалось запустить «${name}».`, LOGS);
        if (choice === LOGS) await showNotebookLogs(client, ws, item.notebook);
      }
      });
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
      const APP = "Открыть приложение";
      const choice = await vscode.window.showQuickPick(
        [
          { label: APP, description: "Адрес приложения без Jupyter-маршрута" },
          { label: TREE, description: "Классический интерфейс Jupyter" },
          { label: LAB, description: "JupyterLab" },
        ],
        { title: `Открыть «${item.notebook.name}» в браузере`, ignoreFocusOut: true },
      );
      if (!choice) return;
      if (item.contextGeneration !== session.getGeneration()) return;
      const ws = session.get();
      const absolute = toAbsoluteNotebookUrl(url);
      const base = absolute.endsWith("/") ? absolute : `${absolute}/`;
      const page = choice.label === LAB ? "lab/" : choice.label === TREE ? "tree/" : "";
      const suffix = choice.label !== APP && ws ? `?ws=${encodeURIComponent(ws.workspaceId)}` : "";
      await vscode.env.openExternal(vscode.Uri.parse(`${base}${page}${suffix}`));
    }),

    run("cloudru.showLogs", async (...args: unknown[]) => {
      const item = args[0] as NotebookTreeItem | undefined;
      const ws = session.get();
      if (!item || !ws) return;
      await showNotebookLogs(client, ws, item.notebook);
    }),

    run("cloudru.downloadLogs", async (...args: unknown[]) => {
      const item = args[0] as NotebookTreeItem | undefined;
      const ws = session.get();
      if (!item || !ws) return;
      await downloadNotebookLogs(client, ws, item.notebook);
    }),

    run("cloudru.editDescription", async (...args: unknown[]) => {
      const item = args[0] as NotebookTreeItem | undefined;
      const ws = session.get();
      if (!item || !ws) return;
      await editNotebookDescription(
        client, ws, item.notebook,
        () => item.contextGeneration === session.getGeneration(),
        () => tree.refresh(),
      );
    }),

    run("cloudru.deleteNotebook", async (...args: unknown[]) => {
      const item = args[0] as NotebookTreeItem | undefined;
      const ws = session.get();
      if (!item || !ws) return;
      await withNotebookOperation(item, async () => {
      const { name, uid } = item.notebook;
      const CONFIRM = "Удалить";
      const choice = await vscode.window.showWarningMessage(
        `«${name}» будет удален без возможности восстановления.`,
        { modal: true },
        CONFIRM,
      );
      if (choice !== CONFIRM) return;
      if (item.contextGeneration !== session.getGeneration()) return;
      const submitted = await submitAndObserve(
        () => client.deleteNotebook(ws, uid),
        () => client.listNotebooks(ws),
        (nb) => nb === undefined || nb.status === "deleted",
        uid, item.contextGeneration, tree,
      );
      if (!submitted) return;
      const outcome = await pollUntil(client, ws, uid, tree, {
        title: `Ожидание удаления «${name}»…`,
        timeoutMs: 120_000,
        isComplete: (nb) => nb === undefined || nb.status === "deleted",
        isFailed: (nb) => nb?.status === "error" || nb?.status === "rejected",
        timeoutMessage: `«${name}»: удаление занимает дольше обычного — обновите список позже.`,
      }, item.contextGeneration);
      if (outcome.kind === "done") invalidateTunnels(uid);
      if (outcome.kind === "failed") {
        void vscode.window.showErrorMessage(`Не удалось удалить «${name}» — проверьте статус ноутбука в списке.`);
      }
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

    run("cloudru.uploadSshKey", async () => {
      await ssh.uploadOwnPublicKey();
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
    if (err instanceof NotSignedInError || (err instanceof ApiError && err.isAuth)) throw err;
    logger.error("Failed to load Cloud.ru workspaces", err);
    const RETRY = "Повторить загрузку";
    const MANUAL = "Ввести ID вручную";
    const choice = await vscode.window.showErrorMessage(
      `Не удалось загрузить воркспейсы Cloud.ru: ${errorMessage(err)}`,
      RETRY, MANUAL,
    );
    if (choice === RETRY) await selectWorkspace(client, session, logger);
    else if (choice === MANUAL) await enterWorkspaceIdManually(session, err);
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
 * (2.4). Artifact-registry images need no lookup; lookup failures propagate so a resume is never
 * sent with silently empty labels — the command's error handling shows the cause to the user.
 */
async function resolveResumeBody(
  client: ConsoleApiClient,
  ws: WorkspaceContext,
  notebook: NotebookHandlerResponse,
): Promise<ResumeBody> {
  if (notebook.imageSource === "artifact_registry") return buildResumeBody(notebook);
  const { name, tag } = splitImageRef(notebook.image || "");
  const resolved = await client.findResumeImage(ws, { region: notebook.region, imageName: name, tag });
  return buildResumeBody(notebook, resolved);
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
  const namespace = requireNamespace(notebook, ws);
  if (!namespace) return;
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

/**
 * Download the notebook logs archive for a quick time range and save it next to where the user
 * points. Mirrors the web console's "Скачать логи" submenu (1/3/7 days).
 */
async function downloadNotebookLogs(
  client: ConsoleApiClient,
  ws: WorkspaceContext,
  notebook: NotebookHandlerResponse,
): Promise<void> {
  const namespace = requireNamespace(notebook, ws);
  if (!namespace) return;

  const DAY = "последние сутки";
  const DAYS3 = "последние 3 дня";
  const DAYS7 = "последние 7 дней";
  const choice = await vscode.window.showQuickPick([DAY, DAYS3, DAYS7], {
    title: `Скачать логи «${notebook.name}»`,
    ignoreFocusOut: true,
  });
  if (!choice) return;
  const days = choice === DAY ? 1 : choice === DAYS3 ? 3 : 7;

  const destination = await vscode.window.showSaveDialog({
    saveLabel: "Сохранить логи",
    defaultUri: vscode.Uri.file(`${notebook.name}.txt`),
  });
  if (!destination) return;

  try {
    const { fileName, content } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Формируется архив логов «${notebook.name}»…` },
      () =>
        client.downloadNotebookLogs(ws, {
          namespace,
          notebookName: notebook.name,
          region: notebook.region,
          startDate: isoDaysAgo(days),
        }),
    );
    // Prefer a user-chosen name, but keep the server-side extension when the picked name has none.
    const target = hasExtension(destination) ? destination : destination.with({ path: `${destination.path}.${extOf(fileName)}` });
    await fs.promises.writeFile(target.fsPath, content, "utf8");
    void vscode.window.showInformationMessage(`Логи «${notebook.name}» сохранены: ${target.path.split("/").pop()}`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Не удалось скачать логи «${notebook.name}»: ${errorMessage(err)}`);
  }
}

/** Namespace for the notebook-scoped endpoints; falls back to the per-notebook value and toasts. */
function requireNamespace(notebook: NotebookHandlerResponse, ws: WorkspaceContext): string | undefined {
  const namespace = ws.namespace ?? notebook.namespace;
  if (!namespace) {
    void vscode.window.showErrorMessage(
      `Операция с «${notebook.name}»: неизвестен namespace воркспейса. Выполните «Cloud.ru: Выбрать воркспейс» и повторите.`,
    );
  }
  return namespace;
}

/** The modify endpoint replaces the editable fields wholesale, so unchanged values are echoed back. */
async function editNotebookDescription(
  client: ConsoleApiClient,
  ws: WorkspaceContext,
  notebook: NotebookHandlerResponse,
  isCurrent: () => boolean,
  refresh: () => void,
): Promise<void> {
  const description = await vscode.window.showInputBox({
    title: `Описание «${notebook.name}»`,
    prompt: "До 64 символов; видно в списке расширения и в консоли Cloud.ru.",
    value: notebook.description ?? "",
    ignoreFocusOut: true,
    validateInput: (v) =>
      v.length > MAX_DESCRIPTION_LENGTH ? `Максимум ${MAX_DESCRIPTION_LENGTH} символов` : undefined,
  });
  if (description === undefined || !isCurrent()) return;
  const latest = (await client.listNotebooks(ws)).find((item) => item.uid === notebook.uid);
  if (!isCurrent()) return;
  if (!latest) throw new ApiError("notFound", `Ноутбук «${notebook.name}» больше не найден в воркспейсе.`);
  await client.modifyNotebook(ws, notebook.uid, {
    description,
    ...(latest.s3Buckets
      ? {
          s3_buckets: latest.s3Buckets.map((b) => ({
            bucket_name: b.name,
            ...(b.accessRule !== undefined ? { access_rule: b.accessRule } : {}),
          })),
        }
      : {}),
    ...(latest.autoshutdownConfig !== undefined ? { autoshutdown_config: latest.autoshutdownConfig } : {}),
  });
  refresh();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasExtension(uri: vscode.Uri): boolean {
  return path.extname(uri.path).length > 0;
}

/** File extension from a file name, without the dot ("logs.txt" → "txt"). */
function extOf(fileName: string): string {
  const ext = path.extname(fileName);
  return ext.startsWith(".") ? ext.slice(1) : "txt";
}

/** Project preflight; treats any failure as active so a flaky preflight never blocks the user. */
async function isProjectActive(client: ConsoleApiClient, ws: WorkspaceContext): Promise<boolean> {
  return (await client.getProjectStatus(ws)).access;
}

/** Refresh the tree's preflight warning line for the current workspace. */
async function refreshPreflightWarning(
  client: ConsoleApiClient,
  ws: WorkspaceContext,
  tree: NotebooksTreeProvider,
  generation: number,
): Promise<void> {
  try {
    const active = await isProjectActive(client, ws);
    tree.setPreflightWarning(
      active ? undefined : "Проект приостановлен: не хватает средств или прав для создания и подключения Jupyter Server.",
      generation,
    );
  } catch (err) {
    tree.setPreflightWarning(`Не удалось проверить состояние проекта: ${errorMessage(err)}`, generation);
  }
}
interface PollUntilOptions {
  title: string;
  timeoutMs: number;
  isComplete: (nb: NotebookHandlerResponse | undefined) => boolean;
  isFailed?: (nb: NotebookHandlerResponse | undefined) => boolean;
  timeoutMessage: string;
}

/** A lost POST response is ambiguous: inspect current state, but never replay the mutation. */
async function submitAndObserve(
  submit: () => Promise<unknown>,
  list: () => Promise<NotebookHandlerResponse[]>,
  isComplete: (nb: NotebookHandlerResponse | undefined) => boolean,
  uid: string,
  generation: number,
  tree: NotebooksTreeProvider,
): Promise<boolean> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Cloud.ru: отправка запроса…" },
      submit,
    );
    return true;
  } catch (err) {
    if (!(err instanceof ApiError) || err.kind !== "network") throw err;
    try {
      const notebooks = await list();
      tree.applyNotebooks(notebooks, generation);
      if (isComplete(notebooks.find((notebook) => notebook.uid === uid))) return true;
    } catch {
      // The submission is still ambiguous; the original error is the useful diagnostic.
    }
    void vscode.window.showWarningMessage(
      `Не удалось подтвердить результат запроса: ${err.message}. Повторно команда не отправлена; обновите список и проверьте статус ноутбука.`,
    );
    return false;
  }
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
  generation: number,
): Promise<PollOutcome> {
  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: opts.title, cancellable: true },
    async (_progress, token) => {
      const abort = new AbortController();
      const listener = token.onCancellationRequested(() => abort.abort());
      if (token.isCancellationRequested) abort.abort();
      try {
        return await pollNotebookStatus({
        list: (signal) => client.listNotebooks(ws, signal),
        uid,
        isComplete: opts.isComplete,
        ...(opts.isFailed ? { isFailed: opts.isFailed } : {}),
        onNotebooks: (list) => tree.applyNotebooks(list, generation),
        isCancelled: () => token.isCancellationRequested,
        signal: abort.signal,
        isSignedOutError: (err) => err instanceof NotSignedInError,
        timeoutMs: opts.timeoutMs,
        });
      } finally {
        listener.dispose();
      }
    },
  );
  tree.refresh();
  if (outcome.kind === "networkErrors") {
    const detail = outcome.error instanceof ApiError ? outcome.error.message : String(outcome.error);
    void vscode.window.showErrorMessage(`Cloud.ru: потеряна связь при отслеживании статуса. ${detail}`);
  } else if (outcome.kind === "requestError") {
    void vscode.window.showErrorMessage(outcome.error.message);
  } else if (outcome.kind === "timeout") {
    void vscode.window.showWarningMessage(opts.timeoutMessage);
  } else if (outcome.kind === "cancelled") {
    void vscode.window.showInformationMessage("Отслеживание остановлено. Операция на сервере может продолжаться; обновите список позже.");
  }
  return outcome;
}

async function withErrorHandling(
  auth: ConsoleTokenProvider,
  logger: Logger,
  retryable: boolean,
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
        await auth.handleExpiredSession(); // single expiry path: one "Войти" toast
        return;
      }
      if (err.kind === "network" && retryable) {
        const RETRY = "Повторить";
        const choice = await vscode.window.showErrorMessage(err.message, RETRY);
        if (choice === RETRY) await withErrorHandling(auth, logger, retryable, body, ...args);
        return;
      }
      void vscode.window.showErrorMessage(err.message);
      return;
    }
    logger.error("Unexpected command error", err);
    void vscode.window.showErrorMessage(`Cloud.ru: ${String(err)}`);
  }
}
