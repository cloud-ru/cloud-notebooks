// Pure builder for the per-notebook action list shown in the QuickPick / context submenu. No `vscode`
// → unit-testable. Unavailable actions are kept (not hidden) with a reason in `description` and no
// `command`, so the user sees *why* an action is greyed out (improvement-plan 4.1). Monitoring is the
// one exception the web app hides outright (DGX2_MT).
import type { NotebookHandlerResponse } from "../api/types";
import { presentNotebookStatus } from "../util/notebookStatus";

export interface NotebookAction {
  label: string;
  /** Hint when enabled, or "Недоступно: …" / "Нет доступа: …" when disabled. */
  description: string;
  /** Command to run, or undefined when the action is shown disabled. */
  command?: string;
  /** Argument passing convention: commands receive the tree item, favorites included. */
}

const NO_ACCESS = "Нет доступа: индивидуальный Jupyter Server другого пользователя";
const DGX2_REGION = "DGX2_MT";

export function buildNotebookActions(nb: NotebookHandlerResponse, isFavorite: boolean): NotebookAction[] {
  const p = presentNotebookStatus(nb.status);
  const access = nb.accessGranted !== false;
  const isDeleted = nb.status === "deleted";
  const notRunning = "Недоступно: ноутбук не запущен";

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
      p.isRunning && access,
      !access ? NO_ACCESS : notRunning,
    ),
    gate(
      "Открыть в браузере",
      "Jupyter или JupyterLab в новой вкладке",
      "cloudru.openNotebookInBrowser",
      p.isRunning,
      notRunning,
    ),
    gate(
      "Запустить",
      "Включить остановленный сервер (счёт за ресурсы возобновится)",
      "cloudru.resumeNotebook",
      p.isPaused,
      "Недоступно: ноутбук не на паузе",
    ),
    gate(
      "Остановить",
      "Несохранённые данные вне NFS будут утеряны",
      "cloudru.pauseNotebook",
      p.isRunning,
      "Недоступно: ноутбук не запущен",
    ),
    gate(
      "Показать логи",
      "Логи ноутбука и причина статуса",
      "cloudru.showLogs",
      !p.isPaused && !p.isBusy && !isDeleted && access,
      !access ? NO_ACCESS : "Недоступно для этого статуса",
    ),
    gate(
      "Файлы по SSH",
      "Открыть домашнюю папку ноутбука через SFTP",
      "cloudru.openNotebookFiles",
      p.isRunning && access,
      !access ? NO_ACCESS : notRunning,
    ),
    gate(
      "Полный IDE (Remote-SSH)",
      "Удалённое окно разработки (терминал + IntelliSense)",
      "cloudru.openFullIde",
      p.isRunning && access,
      !access ? NO_ACCESS : notRunning,
    ),
  ];

  // Monitoring is hidden entirely for DGX2_MT (mirrors the web app), otherwise shown for run/paused.
  if (nb.region !== DGX2_REGION) {
    actions.push(
      gate(
        "Открыть мониторинг в консоли",
        "Страница мониторинга в веб-консоли",
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
      !p.isBusy && !isDeleted,
      "Недоступно: операция уже выполняется",
    ),
    isFavorite
      ? { label: "Убрать из избранного", description: "", command: "cloudru.removeFavorite" }
      : { label: "В избранное", description: "", command: "cloudru.addFavorite" },
  );

  return actions;
}
