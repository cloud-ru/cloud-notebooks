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
 * focus. Overlapping fetches are deduped by ConsoleApiClient.
 */
export class AutoRefresh {
  private timer: NodeJS.Timeout | undefined;
  private focusListener: vscode.Disposable | undefined;
  private version = 0;
  private disposed = false;

  constructor(private readonly deps: AutoRefreshDeps) {}

  start(): void {
    this.focusListener = vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused || this.disposed) return;
      this.version++;
      clearTimeout(this.timer);
      void this.tick(this.version);
    });
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.disposed) return;
    const interval = this.deps.hasBusy() ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS;
    const version = this.version;
    this.timer = setTimeout(() => void this.tick(version), interval);
  }

  private async tick(version: number): Promise<void> {
    if (this.disposed || version !== this.version) return;
    try {
      if (vscode.window.state.focused && (await this.deps.isActive()) && !this.disposed && version === this.version && vscode.window.state.focused) {
        this.deps.refresh();
      }
    } finally {
      if (version === this.version) this.scheduleNext();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.focusListener?.dispose();
    clearTimeout(this.timer);
  }
}
