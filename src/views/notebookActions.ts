// Pure builder for the per-notebook action list shown in the QuickPick / context submenu. No `vscode`
// → unit-testable. Unavailable actions are kept (not hidden) with a reason in `description` and no
// `command`, so the user sees *why* an action is greyed out. Monitoring is the one exception the web
// console hides outright.
import type { NotebookHandlerResponse } from "../api/types";
import { presentNotebookStatus } from "../util/notebookStatus";

export interface NotebookAction {
  label: string;
  /** Hint when enabled, or "Недоступно: …" / "Нет доступа: …" when disabled. */
  description: string;
  /** Command to run, or undefined when the action is shown disabled. */
  command?: string;
}

const NO_ACCESS = "Нет доступа: индивидуальный Jupyter Server другого пользователя";
const DGX2_REGION = "DGX2_MT";

export function buildNotebookActions(nb: NotebookHandlerResponse, isFavorite: boolean): NotebookAction[] {
  const p = presentNotebookStatus(nb.status);
  const access = nb.accessGranted !== false;
  const isDeleted = nb.status === "deleted";
  const hasUrl = Boolean(nb.url);
  const transition = "Недоступно: идёт смена статуса";
  // Running is a precondition of everything below; a transient status gets its own reason instead of
  // the misleading "ноутбук не запущен".
  const notRunning = p.isBusy ? transition : "Недоступно: ноутбук не запущен";
  const notConnectable = p.isRunning && !hasUrl ? "Недоступно: URL ноутбука ещё не получен" : notRunning;

  const gate = (
    label: string,
    hint: string,
    command: string,
    enabled: boolean,
    reason: string,
  ): NotebookAction => (enabled ? { label, description: hint, command } : { label, description: reason });

  const actions: NotebookAction[] = [
    gate(
      "Открыть в VS Code",
      "Веб-интерфейс ноутбука во вкладке редактора",
      "cloudru.openNotebook",
      p.isRunning && hasUrl && access,
      !access ? NO_ACCESS : notConnectable,
    ),
    gate(
      "Открыть в браузере",
      "Jupyter или JupyterLab в новой вкладке",
      "cloudru.openNotebookInBrowser",
      p.isRunning && hasUrl && access,
      !access ? NO_ACCESS : notConnectable,
    ),
    gate(
      "Запустить",
      "Включить остановленный сервер (счёт за ресурсы возобновится)",
      "cloudru.resumeNotebook",
      p.isPaused && access,
      !access ? NO_ACCESS : p.isBusy ? transition : "Недоступно: ноутбук не на паузе",
    ),
    gate(
      "Остановить",
      "Несохранённые данные вне NFS будут утеряны",
      "cloudru.pauseNotebook",
      p.isRunning && access,
      !access ? NO_ACCESS : p.isBusy ? transition : "Недоступно: ноутбук не запущен",
    ),
    gate(
      "Изменить описание…",
      "Описание показывается в списке и в консоли",
      "cloudru.editDescription",
      !p.isBusy && !isDeleted && access,
      !access
        ? NO_ACCESS
        : p.isBusy
          ? transition
          : "Недоступно для этого статуса",
    ),
    gate(
      "Показать логи",
      "Логи ноутбука и причина статуса",
      "cloudru.showLogs",
      !p.isPaused && !p.isBusy && !isDeleted && access,
      !access ? NO_ACCESS : "Недоступно для этого статуса",
    ),
    gate(
      "Скачать логи…",
      "Логи за последние сутки/3/7 дней в файл",
      "cloudru.downloadLogs",
      !p.isPaused && !p.isBusy && !isDeleted && access,
      !access ? NO_ACCESS : "Недоступно для этого статуса",
    ),
    gate(
      "Файлы по SSH",
      "Открыть домашнюю папку ноутбука через SFTP",
      "cloudru.openNotebookFiles",
      p.isRunning && hasUrl && access,
      !access ? NO_ACCESS : notConnectable,
    ),
    gate(
      "Полный IDE (Remote-SSH)",
      "Удалённое окно разработки (терминал + IntelliSense)",
      "cloudru.openFullIde",
      p.isRunning && hasUrl && access,
      !access ? NO_ACCESS : notConnectable,
    ),
  ];

  // Monitoring is hidden entirely for DGX2_MT (mirrors the web app), otherwise shown for run/paused.
  if (nb.region !== DGX2_REGION) {
    actions.push(
      gate(
        "Открыть консоль (мониторинг)",
        "Найдите мониторинг этого сервера в консоли",
        "cloudru.openMonitoring",
        p.isRunning || p.isPaused,
        "Недоступно для этого статуса",
      ),
    );
  }

  actions.push(
    gate(
      "Удалить…",
      "Удалить сервер без возможности восстановления",
      "cloudru.deleteNotebook",
      !p.isBusy && !isDeleted && access,
      !access ? NO_ACCESS : "Недоступно: операция уже выполняется",
    ),
    isFavorite
      ? { label: "Убрать из избранного", description: "", command: "cloudru.removeFavorite" }
      : { label: "В избранное", description: "", command: "cloudru.addFavorite" },
  );

  return actions;
}
