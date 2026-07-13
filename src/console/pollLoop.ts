// Pure polling loop for notebook lifecycle operations (pause/resume/delete). No `vscode`/network →
// unit-testable. The command layer wraps this with a cancellable progress notification and toasts.
//
// It reacts to session expiry (stop silently — the token provider already prompts), a terminal failure
// status (stop with a reason), a run of transport errors (give up after N), cancellation, and timeout.
import type { NotebookHandlerResponse } from "../api/types";

export type PollOutcome =
  | { kind: "done"; notebook: NotebookHandlerResponse | undefined }
  | { kind: "failed"; notebook: NotebookHandlerResponse | undefined }
  | { kind: "cancelled" }
  | { kind: "signedOut" }
  | { kind: "networkErrors"; error: unknown }
  | { kind: "timeout" };

export interface PollLoopDeps {
  /** One notebook-list fetch per iteration (deduped upstream). */
  list: () => Promise<NotebookHandlerResponse[]>;
  /** uid of the notebook being watched. */
  uid: string;
  /** Terminal success predicate; receives the notebook (or undefined when it left the list). */
  isComplete: (notebook: NotebookHandlerResponse | undefined) => boolean;
  /** Terminal failure predicate (e.g. resume ended in `error`/`rejected`). */
  isFailed?: (notebook: NotebookHandlerResponse | undefined) => boolean;
  /** Feed each fresh list straight to the tree so we never double-fetch (H8). */
  onNotebooks?: (notebooks: NotebookHandlerResponse[]) => void;
  /** True when the user cancelled the progress. */
  isCancelled?: () => boolean;
  /** Recognizes a "session expired" error so the loop stops instead of hammering headless mints (H3). */
  isSignedOutError?: (error: unknown) => boolean;
  timeoutMs: number;
  intervalMs?: number;
  /** Consecutive transport errors tolerated before giving up (H4). */
  maxConsecutiveErrors?: number;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 3000;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;

function realDelay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export async function pollNotebookStatus(deps: PollLoopDeps): Promise<PollOutcome> {
  const now = deps.now ?? Date.now;
  const delay = deps.delay ?? realDelay;
  const interval = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxErrors = deps.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;
  const deadline = now() + deps.timeoutMs;
  let consecutiveErrors = 0;

  while (now() < deadline) {
    if (deps.isCancelled?.()) return { kind: "cancelled" };

    let notebooks: NotebookHandlerResponse[];
    try {
      notebooks = await deps.list();
      consecutiveErrors = 0;
    } catch (error) {
      if (deps.isSignedOutError?.(error)) return { kind: "signedOut" };
      if (++consecutiveErrors >= maxErrors) return { kind: "networkErrors", error };
      await delay(interval);
      continue;
    }

    deps.onNotebooks?.(notebooks);
    const notebook = notebooks.find((n) => n.uid === deps.uid);
    if (deps.isComplete(notebook)) return { kind: "done", notebook };
    if (deps.isFailed?.(notebook)) return { kind: "failed", notebook };

    if (deps.isCancelled?.()) return { kind: "cancelled" };
    await delay(interval);
  }
  return { kind: "timeout" };
}
