import * as vscode from "vscode";

/** Poll cadence: fast while notebooks are in transient states, slow otherwise (mirrors the web app). */
const BUSY_INTERVAL_MS = 15_000;
const IDLE_INTERVAL_MS = 60_000;

export interface AutoRefreshDeps {
  /** Signed in AND a workspace is selected — nothing to poll otherwise. */
  isActive: () => Promise<boolean>;
  /** Whether the last list has transient (busy) statuses worth polling fast. */
  hasBusy: () => boolean;
  /** Trigger a tree + kernel-server refresh (deduped downstream). */
  refresh: () => void;
}

/**
 * Background refresher for the notebooks tree: while the window is focused and a workspace is loaded,
 * re-poll every 15s (busy statuses present) or 60s (idle), and pause entirely when the window loses
 * focus (improvement-plan 4.5). Overlapping fetches are deduped by ConsoleApiClient.
 */
export class AutoRefresh {
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly deps: AutoRefreshDeps) {}

  start(): void {
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.disposed) return;
    const interval = this.deps.hasBusy() ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS;
    this.timer = setTimeout(() => void this.tick(), interval);
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    try {
      if (vscode.window.state.focused && (await this.deps.isActive())) this.deps.refresh();
    } finally {
      this.scheduleNext();
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
  }
}
