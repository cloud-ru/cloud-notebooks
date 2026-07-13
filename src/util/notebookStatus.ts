// Presentation helpers for notebook status. Pure module (no `vscode`) so it is unit-testable;
// the tree view maps the returned codicon id / theme color onto a vscode.ThemeIcon.
import type { NotebookStatus } from "../api/types";

export interface StatusPresentation {
  /** Codicon id (without the `$(...)` wrapper). */
  icon: string;
  /** ThemeColor id, or undefined for the default foreground. */
  color?: string;
  /** Human-readable Russian label (from the console). */
  label: string;
  /** Whether the notebook exposes a connectable URL right now. */
  isRunning: boolean;
  /** Whether the notebook is paused and could be resumed. */
  isPaused: boolean;
  /** Whether it is in a transient state worth auto-refreshing. */
  isBusy: boolean;
}

const RUNNING: StatusPresentation = {
  icon: "vm-running",
  color: "charts.green",
  label: "Подключен",
  isRunning: true,
  isPaused: false,
  isBusy: false,
};
const paused = (label: string): StatusPresentation => ({
  icon: "vm-outline",
  label,
  isRunning: false,
  isPaused: true,
  isBusy: false,
});
const busy = (label: string): StatusPresentation => ({
  icon: "loading~spin",
  label,
  isRunning: false,
  isPaused: false,
  isBusy: true,
});
const terminal = (icon: string, label: string, color?: string): StatusPresentation => ({
  icon,
  ...(color ? { color } : {}),
  label,
  isRunning: false,
  isPaused: false,
  isBusy: false,
});

// One entry per NotebookStatus (the Record forces exhaustiveness — a new status won't compile until
// it is presented here). Labels/groups mirror the console (see improvement-plan «Справочник»).
const PRESENTATIONS: Record<NotebookStatus, StatusPresentation> = {
  running: RUNNING,
  paused: paused("На паузе"),
  paused_by_schedule: paused("Остановлен по расписанию"),
  paused_by_metrics: paused("Остановлен по нагрузке"),
  paused_by_timer: paused("Остановлен по времени"),
  creating: busy("Создаётся"),
  for_create: busy("Запускается"),
  pulling: busy("Скачивание образа"),
  waiting: busy("Ожидает ресурсов"),
  resuming: busy("Запускается"),
  for_resume: busy("Запускается"),
  pausing: busy("Останавливается"),
  for_pause: busy("Останавливается"),
  deleting: busy("Удаляется"),
  for_delete: busy("Удаляется"),
  fixing: busy("Нет соединения"),
  error: terminal("error", "Ошибка", "charts.red"),
  warning: terminal("warning", "Предупреждение", "charts.yellow"),
  rejected: terminal("circle-slash", "Не создался", "charts.red"),
  deleted: terminal("trash", "Удален"),
  unknown: terminal("question", "Неизвестно"),
};

export function presentNotebookStatus(status: NotebookStatus): StatusPresentation {
  return PRESENTATIONS[status] ?? PRESENTATIONS.unknown;
}

/** Russian label for a status, for descriptions/tooltips/filters. */
export function statusLabel(status: NotebookStatus): string {
  return presentNotebookStatus(status).label;
}

/** contextValue used by package.json menu `when` clauses. */
export function notebookContextValue(status: NotebookStatus): string {
  const p = presentNotebookStatus(status);
  if (p.isRunning) return "notebook.running";
  if (p.isPaused) return "notebook.paused";
  if (p.isBusy) return "notebook.busy";
  return "notebook.other";
}
