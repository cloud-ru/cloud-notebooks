// Pure polling loop for notebook lifecycle operations (pause/resume/delete). No `vscode`/network →
// unit-testable. The command layer wraps this with a cancellable progress notification and toasts.
//
// It reacts to session expiry (stop silently — the token provider already prompts), a terminal failure
// status (stop with a reason), a run of transport errors (give up after N), cancellation, and timeout.
import type { NotebookHandlerResponse } from "../api/types";
import { ApiError } from "../api/errors";

export type PollOutcome =
  | { kind: "done"; notebook: NotebookHandlerResponse | undefined }
  | { kind: "failed"; notebook: NotebookHandlerResponse | undefined }
  | { kind: "cancelled" }
  | { kind: "signedOut" }
  | { kind: "networkErrors"; error: unknown }
  | { kind: "requestError"; error: ApiError }
  | { kind: "timeout" };

export interface PollLoopDeps {
  /** One notebook-list fetch per iteration (deduped upstream). */
  list: (signal?: AbortSignal) => Promise<NotebookHandlerResponse[]>;
  /** uid of the notebook being watched. */
  uid: string;
  /** Terminal success predicate; receives the notebook (or undefined when it left the list). */
  isComplete: (notebook: NotebookHandlerResponse | undefined) => boolean;
  /** Terminal failure predicate (e.g. resume ended in `error`/`rejected`). */
  isFailed?: (notebook: NotebookHandlerResponse | undefined) => boolean;
  /** Feed each fresh list straight to the tree so we never double-fetch. */
  onNotebooks?: (notebooks: NotebookHandlerResponse[]) => void;
  /** True when the user cancelled the progress. */
  isCancelled?: () => boolean;
  /** Progress cancellation; aborts the waiting subscriber, not a shared API request. */
  signal?: AbortSignal;
  /** Recognizes a "session expired" error so the loop stops instead of hammering headless mints. */
  isSignedOutError?: (error: unknown) => boolean;
  timeoutMs: number;
  intervalMs?: number;
  /** Consecutive transport errors tolerated before giving up. */
  maxConsecutiveErrors?: number;
  now?: () => number;
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 3000;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;

function realDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new Error("Poll cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function awaitAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Poll cancelled"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(new Error("Poll cancelled")); };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

export async function pollNotebookStatus(deps: PollLoopDeps): Promise<PollOutcome> {
  const now = deps.now ?? Date.now;
  const delay = deps.delay ?? realDelay;
  const interval = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxErrors = deps.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;
  const deadline = now() + deps.timeoutMs;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deps.timeoutMs);
  const onExternalAbort = () => controller.abort();
  deps.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (deps.signal?.aborted) onExternalAbort();
  let consecutiveErrors = 0;

  try {
  while (now() < deadline) {
    if (timedOut) return { kind: "timeout" };
    if (controller.signal.aborted || deps.isCancelled?.()) return { kind: "cancelled" };

    let notebooks: NotebookHandlerResponse[];
    try {
      notebooks = await awaitAbort(deps.list(controller.signal), controller.signal);
      consecutiveErrors = 0;
    } catch (error) {
      if (timedOut) return { kind: "timeout" };
      if (controller.signal.aborted || deps.isCancelled?.()) return { kind: "cancelled" };
      if (deps.isSignedOutError?.(error)) return { kind: "signedOut" };
      if (error instanceof ApiError) {
        if (error.isAuth) return { kind: "signedOut" };
        if (error.kind === "forbidden" || error.kind === "notFound" || error.kind === "unknown") {
          return { kind: "requestError", error };
        }
      }
      if (++consecutiveErrors >= maxErrors) return { kind: "networkErrors", error };
      const retryAfter = error instanceof ApiError ? (error.retryAfterSeconds ?? 0) * 1000 : 0;
      try { await awaitAbort(delay(Math.max(interval, retryAfter), controller.signal), controller.signal); }
      catch (delayError) {
        if (timedOut) return { kind: "timeout" };
        if (controller.signal.aborted) return { kind: "cancelled" };
        throw delayError;
      }
      continue;
    }

    if (timedOut) return { kind: "timeout" };
    if (controller.signal.aborted || deps.isCancelled?.()) return { kind: "cancelled" };
    deps.onNotebooks?.(notebooks);
    const notebook = notebooks.find((n) => n.uid === deps.uid);
    if (deps.isComplete(notebook)) return { kind: "done", notebook };
    if (deps.isFailed?.(notebook)) return { kind: "failed", notebook };

    if (deps.isCancelled?.()) return { kind: "cancelled" };
    try { await awaitAbort(delay(interval, controller.signal), controller.signal); }
    catch (delayError) {
      if (timedOut) return { kind: "timeout" };
      if (controller.signal.aborted) return { kind: "cancelled" };
      throw delayError;
    }
  }
  return { kind: "timeout" };
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onExternalAbort);
  }
}
