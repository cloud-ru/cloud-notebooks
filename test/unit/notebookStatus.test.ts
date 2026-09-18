import { describe, expect, it } from "vitest";
import { notebookContextValue, presentNotebookStatus, statusLabel } from "../../src/util/notebookStatus";
import type { NotebookStatus } from "../../src/api/types";

// Full NotebookStatus union (src/api/types.ts) written out as a literal list. Presentation is a
// Record<NotebookStatus, …> in the source, so every member is defended here; adding a status to the
// union without updating this list drops the coverage-count assertion below to red.
const ALL_STATUSES = [
  "creating",
  "for_create",
  "pulling",
  "waiting",
  "resuming",
  "for_resume",
  "running",
  "pausing",
  "for_pause",
  "paused",
  "paused_by_schedule",
  "paused_by_metrics",
  "paused_by_timer",
  "deleting",
  "for_delete",
  "deleted",
  "error",
  "rejected",
  "warning",
  "fixing",
  "unknown",
] as const satisfies readonly NotebookStatus[];

const PAUSED = ["paused", "paused_by_schedule", "paused_by_metrics", "paused_by_timer"] as const satisfies readonly NotebookStatus[];
const BUSY = [
  "creating",
  "for_create",
  "pulling",
  "waiting",
  "resuming",
  "for_resume",
  "pausing",
  "for_pause",
  "deleting",
  "for_delete",
  "fixing",
] as const satisfies readonly NotebookStatus[];
const TERMINAL = ["error", "warning", "rejected", "deleted", "unknown"] as const satisfies readonly NotebookStatus[];

describe("presentNotebookStatus", () => {
  it.each(ALL_STATUSES)("presents %s with a label and at most one active group flag", (status) => {
    const p = presentNotebookStatus(status);
    expect(p.label.length).toBeGreaterThan(0);
    // running / paused / busy are mutually exclusive; terminal states leave all three false.
    const active = [p.isRunning, p.isPaused, p.isBusy].filter(Boolean).length;
    expect(active).toBeLessThanOrEqual(1);
  });

  it("marks running as connectable only", () => {
    expect(presentNotebookStatus("running")).toMatchObject({
      isRunning: true,
      isPaused: false,
      isBusy: false,
    });
  });

  it.each(PAUSED)("marks %s as paused only", (status) => {
    expect(presentNotebookStatus(status)).toMatchObject({
      isRunning: false,
      isPaused: true,
      isBusy: false,
    });
  });

  it.each(BUSY)("marks %s as busy only", (status) => {
    expect(presentNotebookStatus(status)).toMatchObject({
      isRunning: false,
      isPaused: false,
      isBusy: true,
    });
  });

  it.each(TERMINAL)("marks %s as terminal with no active group flag", (status) => {
    expect(presentNotebookStatus(status)).toMatchObject({
      isRunning: false,
      isPaused: false,
      isBusy: false,
    });
  });

  it("partitions all 21 statuses across running / paused / busy / terminal", () => {
    const grouped = ["running", ...PAUSED, ...BUSY, ...TERMINAL];
    expect(grouped.length).toBe(21);
    // No status appears in two groups and none is missing.
    expect(new Set(grouped).size).toBe(21);
    expect(new Set(grouped)).toEqual(new Set(ALL_STATUSES));
    expect(ALL_STATUSES.length).toBe(21);
  });
});

describe("statusLabel", () => {
  // Exact Russian labels from src/util/notebookStatus.ts, one row per status.
  const LABELS = [
    ["running", "Запущен"],
    ["paused", "На паузе"],
    ["paused_by_schedule", "Остановлен по расписанию"],
    ["paused_by_metrics", "Остановлен по нагрузке"],
    ["paused_by_timer", "Остановлен по времени"],
    ["creating", "Создаётся"],
    ["for_create", "Запускается"],
    ["pulling", "Скачивание образа"],
    ["waiting", "Ожидает ресурсов"],
    ["resuming", "Запускается"],
    ["for_resume", "Запускается"],
    ["pausing", "Останавливается"],
    ["for_pause", "Останавливается"],
    ["deleting", "Удаляется"],
    ["for_delete", "Удаляется"],
    ["fixing", "Нет соединения"],
    ["error", "Ошибка"],
    ["warning", "Предупреждение"],
    ["rejected", "Не создался"],
    ["deleted", "Удален"],
    ["unknown", "Неизвестно"],
  ] as const satisfies readonly (readonly [NotebookStatus, string])[];

  it.each(LABELS)("labels %s as %s", (status, label) => {
    expect(statusLabel(status)).toBe(label);
    // statusLabel must surface the presentation's label verbatim.
    expect(presentNotebookStatus(status).label).toBe(label);
  });

  it("covers every status in the union", () => {
    expect(new Set(LABELS.map(([status]) => status))).toEqual(new Set(ALL_STATUSES));
  });
});

describe("notebookContextValue", () => {
  it.each([
    ["running", "notebook.running"],
    ["paused", "notebook.paused"],
    ["paused_by_timer", "notebook.paused"],
    ["creating", "notebook.busy"],
    ["pulling", "notebook.busy"],
    ["for_resume", "notebook.busy"],
    ["fixing", "notebook.busy"],
    ["error", "notebook.other"],
    ["rejected", "notebook.other"],
    ["deleted", "notebook.other"],
    ["warning", "notebook.other"],
    ["unknown", "notebook.other"],
  ] as const satisfies readonly (readonly [NotebookStatus, string])[])("maps %s to %s", (status, expected) => {
    expect(notebookContextValue(status)).toBe(expected);
  });
});
