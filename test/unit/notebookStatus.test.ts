import { describe, expect, it } from "vitest";
import { notebookContextValue, presentNotebookStatus } from "../../src/util/notebookStatus";

describe("presentNotebookStatus", () => {
  it("marks running notebooks as connectable", () => {
    const p = presentNotebookStatus("running");
    expect(p.isRunning).toBe(true);
    expect(p.icon).toBe("vm-running");
  });

  it("marks every paused variant as paused", () => {
    for (const s of ["paused", "paused_by_schedule", "paused_by_metrics", "paused_by_timer"] as const) {
      expect(presentNotebookStatus(s).isPaused).toBe(true);
    }
  });

  it("marks transient states as busy", () => {
    for (const s of ["creating", "resuming", "waiting", "pausing", "deleting", "fixing"] as const) {
      expect(presentNotebookStatus(s).isBusy).toBe(true);
    }
  });
});

describe("notebookContextValue", () => {
  it.each([
    ["running", "notebook.running"],
    ["paused", "notebook.paused"],
    ["creating", "notebook.busy"],
    ["error", "notebook.other"],
  ] as const)("maps %s to %s", (status, expected) => {
    expect(notebookContextValue(status)).toBe(expected);
  });
});
