// Presentation helpers for notebook status. Pure module (no `vscode`) so it is unit-testable;
// the tree view maps the returned codicon id / theme color onto a vscode.ThemeIcon.
import type { NotebookStatus } from "../api/types";

export interface StatusPresentation {
  /** Codicon id (without the `$(...)` wrapper). */
  icon: string;
  /** ThemeColor id, or undefined for the default foreground. */
  color?: string;
  /** Whether the notebook exposes a connectable URL right now. */
  isRunning: boolean;
  /** Whether the notebook is paused and could be resumed. */
  isPaused: boolean;
  /** Whether it is in a transient state worth auto-refreshing. */
  isBusy: boolean;
}

export function presentNotebookStatus(status: NotebookStatus): StatusPresentation {
  switch (status) {
    case "running":
      return { icon: "vm-running", color: "charts.green", isRunning: true, isPaused: false, isBusy: false };
    case "paused":
    case "paused_by_schedule":
    case "paused_by_metrics":
    case "paused_by_timer":
      return { icon: "vm-outline", isRunning: false, isPaused: true, isBusy: false };
    case "creating":
    case "resuming":
    case "waiting":
    case "pausing":
    case "deleting":
    case "fixing":
      return { icon: "loading~spin", isRunning: false, isPaused: false, isBusy: true };
    case "error":
      return { icon: "error", color: "charts.red", isRunning: false, isPaused: false, isBusy: false };
    case "warning":
      return { icon: "warning", color: "charts.yellow", isRunning: false, isPaused: false, isBusy: false };
    default: {
      // Compile-time exhaustiveness guard: adding a NotebookStatus without a case fails here.
      const _exhaustive: never = status;
      void _exhaustive;
      return { icon: "question", isRunning: false, isPaused: false, isBusy: false };
    }
  }
}

/** contextValue used by package.json menu `when` clauses. */
export function notebookContextValue(status: NotebookStatus): string {
  const p = presentNotebookStatus(status);
  if (p.isRunning) return "notebook.running";
  if (p.isPaused) return "notebook.paused";
  if (p.isBusy) return "notebook.busy";
  return "notebook.other";
}
