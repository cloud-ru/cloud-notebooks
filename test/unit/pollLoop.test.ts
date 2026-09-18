import { describe, expect, it } from "vitest";
import { pollNotebookStatus, type PollOutcome } from "../../src/console/pollLoop";
import type { NotebookHandlerResponse, NotebookStatus } from "../../src/api/types";
import { ApiError } from "../../src/api/errors";

function nb(uid: string, status: NotebookStatus): NotebookHandlerResponse {
  return {
    uid,
    name: uid,
    status,
    image: "img",
    imageDisplayName: "Image",
    region: "a100-mt",
    author: "a@x",
    is_shared: false,
    portal_ref: "ref",
  };
}

/** A `list` driven by a script of thunks; each thunk either returns a list or throws. Repeats the
 * final step once exhausted, and records how many fetches happened. */
function scripted(steps: Array<() => NotebookHandlerResponse[]>) {
  const state = { calls: 0 };
  const list = async (): Promise<NotebookHandlerResponse[]> => {
    const step = steps[Math.min(state.calls, steps.length - 1)]!;
    state.calls++;
    return step();
  };
  return { list, state };
}

/** Narrowing assertion so a wrong outcome fails loudly and variant fields stay typed. */
function expectKind<K extends PollOutcome["kind"]>(
  outcome: PollOutcome,
  kind: K,
): Extract<PollOutcome, { kind: K }> {
  if (outcome.kind !== kind) {
    throw new Error(`expected outcome "${kind}", got "${outcome.kind}"`);
  }
  return outcome as Extract<PollOutcome, { kind: K }>;
}

// Every test freezes `now` (so the deadline never trips) except the timeout case, which advances a
// clock inside `delay`. `delay` is always a synchronous no-op — no real timers run.

describe("pollNotebookStatus", () => {
  it("stops a pending list when progress is cancelled", async () => {
    const controller = new AbortController();
    const outcome = pollNotebookStatus({
      list: () => new Promise<NotebookHandlerResponse[]>(() => {}),
      uid: "target", isComplete: () => false, signal: controller.signal,
      timeoutMs: 60_000,
    });
    controller.abort();
    await expect(outcome).resolves.toEqual({ kind: "cancelled" });
  });

  it("times out a pending list without waiting for transport completion", async () => {
    const outcome = await pollNotebookStatus({
      list: () => new Promise<NotebookHandlerResponse[]>(() => {}),
      uid: "target", isComplete: () => false, timeoutMs: 20,
    });
    expect(outcome).toEqual({ kind: "timeout" });
  });

  it("stops immediately on a forbidden response", async () => {
    const { list, state } = scripted([() => { throw new ApiError("forbidden", "No access", { status: 403 }); }]);
    const outcome = await pollNotebookStatus({
      list, uid: "target", isComplete: () => false, timeoutMs: 60_000,
      now: () => 0, delay: async () => {},
    });
    expect(outcome).toMatchObject({ kind: "requestError" });
    expect(state.calls).toBe(1);
  });

  it("uses Retry-After for a rate limited list request", async () => {
    const { list } = scripted([
      () => { throw new ApiError("rateLimit", "Slow down", { status: 429, retryAfterSeconds: 5 }); },
      () => [nb("target", "running")],
    ]);
    const delays: number[] = [];
    const outcome = await pollNotebookStatus({
      list, uid: "target", isComplete: (item) => item?.status === "running",
      timeoutMs: 60_000, now: () => 0,
      delay: async (ms) => { delays.push(ms); },
    });
    expect(outcome.kind).toBe("done");
    expect(delays).toEqual([5_000]);
  });

  it("resolves 'done' when the watched notebook satisfies isComplete", async () => {
    const seen: NotebookHandlerResponse[][] = [];
    const { list, state } = scripted([
      () => [nb("target", "resuming"), nb("other", "running")],
      () => [nb("target", "resuming")],
      () => [nb("target", "running")],
    ]);

    const outcome = await pollNotebookStatus({
      list,
      uid: "target",
      isComplete: (n) => n?.status === "running",
      onNotebooks: (nbs) => seen.push(nbs),
      timeoutMs: 60_000,
      intervalMs: 1000,
      now: () => 0,
      delay: async () => {},
    });

    const done = expectKind(outcome, "done");
    // Found by uid — the sibling "other" is running but must not satisfy completion.
    expect(done.notebook?.uid).toBe("target");
    expect(done.notebook?.status).toBe("running");
    expect(state.calls).toBe(3);

    // onNotebooks fed every fetched list, in order.
    expect(seen).toHaveLength(3);
    expect(seen[0]?.map((n) => n.uid)).toEqual(["target", "other"]);
    expect(seen[2]?.[0]?.status).toBe("running");
  });

  it("resolves 'failed' when isFailed becomes true", async () => {
    const { list, state } = scripted([
      () => [nb("target", "resuming")],
      () => [nb("target", "error")],
    ]);

    const outcome = await pollNotebookStatus({
      list,
      uid: "target",
      isComplete: (n) => n?.status === "running",
      isFailed: (n) => n?.status === "error" || n?.status === "rejected",
      timeoutMs: 60_000,
      now: () => 0,
      delay: async () => {},
    });

    const failed = expectKind(outcome, "failed");
    expect(failed.notebook?.status).toBe("error");
    expect(state.calls).toBe(2);
  });

  it("resolves 'cancelled' before any fetch when isCancelled is already true", async () => {
    const { list, state } = scripted([() => [nb("target", "resuming")]]);
    let delayCalls = 0;

    const outcome = await pollNotebookStatus({
      list,
      uid: "target",
      isComplete: () => false,
      isCancelled: () => true,
      timeoutMs: 60_000,
      now: () => 0,
      delay: async () => {
        delayCalls++;
      },
    });

    expectKind(outcome, "cancelled");
    // Stops promptly: the pre-fetch checkpoint fires, so nothing is fetched and nothing sleeps.
    expect(state.calls).toBe(0);
    expect(delayCalls).toBe(0);
  });

  it("resolves 'cancelled' at the post-fetch checkpoint after one poll", async () => {
    let cancelled = false;
    const { list, state } = scripted([() => [nb("target", "resuming")]]);

    const outcome = await pollNotebookStatus({
      list,
      uid: "target",
      isComplete: () => false,
      isCancelled: () => cancelled,
      onNotebooks: () => {
        cancelled = true;
      },
      timeoutMs: 60_000,
      now: () => 0,
      delay: async () => {},
    });

    expectKind(outcome, "cancelled");
    // Exactly one fetch: cancellation observed after the list arrives, before the next iteration.
    expect(state.calls).toBe(1);
  });

  it("resolves 'signedOut' immediately when a fetch throws a session-expiry error", async () => {
    const authErr = new Error("session expired");
    const { list, state } = scripted([
      () => {
        throw authErr;
      },
    ]);
    let delayCalls = 0;
    const classified: unknown[] = [];

    const outcome = await pollNotebookStatus({
      list,
      uid: "target",
      isComplete: () => false,
      isSignedOutError: (e) => {
        classified.push(e);
        return true;
      },
      maxConsecutiveErrors: 5,
      timeoutMs: 60_000,
      now: () => 0,
      delay: async () => {
        delayCalls++;
      },
    });

    expectKind(outcome, "signedOut");
    // No further polling and no backoff sleep — it bails on the first sign-out.
    expect(state.calls).toBe(1);
    expect(delayCalls).toBe(0);
    // It classified the actual thrown error, not some fabricated one.
    expect(classified[0]).toBe(authErr);
  });

  it("resolves 'networkErrors' carrying the error after maxConsecutiveErrors failures", async () => {
    const boom = new Error("network down");
    const { list, state } = scripted([
      () => {
        throw boom;
      },
    ]);
    let delayCalls = 0;

    const outcome = await pollNotebookStatus({
      list,
      uid: "target",
      isComplete: () => false,
      isSignedOutError: () => false,
      maxConsecutiveErrors: 3,
      timeoutMs: 60_000,
      now: () => 0,
      delay: async () => {
        delayCalls++;
      },
    });

    const net = expectKind(outcome, "networkErrors");
    expect(net.error).toBe(boom);
    // Gives up exactly on the 3rd consecutive failure...
    expect(state.calls).toBe(3);
    // ...having backed off only between the first two, never after the final give-up.
    expect(delayCalls).toBe(2);
  });

  it("resets the consecutive-error counter after a success and eventually reaches 'done'", async () => {
    const boom = new Error("blip");
    const { list, state } = scripted([
      () => {
        throw boom; // consecutive = 1
      },
      () => [nb("target", "resuming")], // success -> resets to 0
      () => {
        throw boom; // consecutive = 1 again (not 2)
      },
      () => [nb("target", "running")], // success -> done
    ]);

    const outcome = await pollNotebookStatus({
      list,
      uid: "target",
      isComplete: (n) => n?.status === "running",
      isSignedOutError: () => false,
      // With a cap of 2 and no reset, the 3rd fetch (2nd error) would trip "networkErrors".
      maxConsecutiveErrors: 2,
      timeoutMs: 60_000,
      now: () => 0,
      delay: async () => {},
    });

    const done = expectKind(outcome, "done");
    expect(done.notebook?.status).toBe("running");
    expect(state.calls).toBe(4);
  });

  it("resolves 'timeout' when the clock passes the deadline before completion", async () => {
    let clock = 0;
    const { list, state } = scripted([() => [nb("target", "resuming")]]);

    const outcome = await pollNotebookStatus({
      list,
      uid: "target",
      isComplete: () => false,
      timeoutMs: 100,
      intervalMs: 50,
      now: () => clock,
      delay: async (ms) => {
        clock += ms;
      },
    });

    expectKind(outcome, "timeout");
    // deadline = 100. Polls at t=0 and t=50 (both < 100); at t=100 the `now() < deadline` guard
    // fails, so it stops — 2 fetches. A `<=` boundary would allow a 3rd. No real time elapsed.
    expect(state.calls).toBe(2);
  });
});
