import { describe, expect, it } from "vitest";
import { buildNotebookActions, type NotebookAction } from "../../src/views/notebookActions";
import type { NotebookHandlerResponse, NotebookStatus } from "../../src/api/types";

function nb(p: Partial<NotebookHandlerResponse>): NotebookHandlerResponse {
  return {
    uid: "u",
    name: "nb",
    status: "running",
    image: "cr.ai.cloud.ru/img/base:1.2",
    imageDisplayName: "Base",
    region: "a100-mt",
    author: "a@x",
    is_shared: false,
    portal_ref: "ref",
    ...p,
  } as NotebookHandlerResponse;
}

function find(actions: NotebookAction[], label: string): NotebookAction | undefined {
  return actions.find((a) => a.label === label);
}

// Exact reason string from the source; a disabled action must both drop its command AND surface this.
const NO_ACCESS = "Нет доступа: индивидуальный Jupyter Server другого пользователя";
const MONITORING = "Открыть мониторинг в консоли";
const DELETE = "Удалить…";

describe("buildNotebookActions", () => {
  describe("running notebook with access granted", () => {
    const actions = buildNotebookActions(nb({ status: "running" }), false);

    it.each([
      ["Открыть в VS Code", "cloudru.openNotebook"],
      ["Остановить", "cloudru.pauseNotebook"],
      ["Файлы по SSH", "cloudru.openNotebookFiles"],
      ["Полный IDE (Remote-SSH)", "cloudru.openFullIde"],
      ["Показать логи", "cloudru.showLogs"],
      ["Скачать логи…", "cloudru.downloadLogs"],
      ["Изменить описание…", "cloudru.editDescription"],
    ])("enables %s", (label, command) => {
      expect(find(actions, label)?.command).toBe(command);
    });

    it("disables Запустить with the not-on-pause reason", () => {
      const a = find(actions, "Запустить");
      expect(a?.command).toBeUndefined();
      expect(a?.description).toBe("Недоступно: ноутбук не на паузе");
    });
  });

  describe("paused notebook", () => {
    const actions = buildNotebookActions(nb({ status: "paused" }), false);

    it("enables Запустить", () => {
      expect(find(actions, "Запустить")?.command).toBe("cloudru.resumeNotebook");
    });

    it.each(["Открыть в VS Code", "Остановить", "Файлы по SSH", "Полный IDE (Remote-SSH)"])(
      "disables %s with the not-running reason",
      (label) => {
        const a = find(actions, label);
        expect(a?.command).toBeUndefined();
        expect(a?.description).toBe("Недоступно: ноутбук не запущен");
      },
    );
  });

  describe("running notebook without access (another user's server)", () => {
    const actions = buildNotebookActions(nb({ status: "running", accessGranted: false }), false);

    it.each(["Открыть в VS Code", "Файлы по SSH", "Полный IDE (Remote-SSH)", "Показать логи", "Скачать логи…", "Изменить описание…"])(
      "disables %s with the no-access reason",
      (label) => {
        const a = find(actions, label);
        expect(a?.command).toBeUndefined();
        expect(a?.description).toBe(NO_ACCESS);
      },
    );
  });

  describe("transient (busy) statuses use the transition reason, not 'not running'", () => {
    const actions = buildNotebookActions(nb({ status: "pausing" }), false);

    it.each(["Открыть в VS Code", "Остановить", "Файлы по SSH", "Полный IDE (Remote-SSH)", "Запустить"])(
      "disables %s with the transition reason",
      (label) => {
        const a = find(actions, label);
        expect(a?.command).toBeUndefined();
        expect(a?.description).toBe("Недоступно: идёт смена статуса");
      },
    );

    it("disables the delete action because an operation is already in flight", () => {
      const a = find(actions, DELETE);
      expect(a?.command).toBeUndefined();
      expect(a?.description).toBe("Недоступно: операция уже выполняется");
    });
  });

  describe("monitoring", () => {
    it("is shown for a running notebook in a normal region", () => {
      const actions = buildNotebookActions(nb({ status: "running", region: "a100-mt" }), false);
      expect(find(actions, MONITORING)?.command).toBe("cloudru.openMonitoring");
    });

    it("is shown for a paused notebook", () => {
      const actions = buildNotebookActions(nb({ status: "paused" }), false);
      expect(find(actions, MONITORING)?.command).toBe("cloudru.openMonitoring");
    });

    it("is hidden entirely for DGX2_MT", () => {
      const actions = buildNotebookActions(nb({ status: "running", region: "DGX2_MT" }), false);
      expect(find(actions, MONITORING)).toBeUndefined();
    });
  });

  describe("delete", () => {
    it.each(["running", "paused"] as NotebookStatus[])("is enabled for %s", (status) => {
      const actions = buildNotebookActions(nb({ status }), false);
      expect(find(actions, DELETE)?.command).toBe("cloudru.deleteNotebook");
    });

    it.each(["deleting", "deleted"] as NotebookStatus[])(
      "is disabled for the busy/terminal status %s",
      (status) => {
        const a = find(buildNotebookActions(nb({ status }), false), DELETE);
        expect(a?.command).toBeUndefined();
        expect(a?.description).toBe("Недоступно: операция уже выполняется");
      },
    );
  });

  describe("favorite toggle", () => {
    it("offers removal when already a favorite", () => {
      const actions = buildNotebookActions(nb({}), true);
      expect(find(actions, "Убрать из избранного")?.command).toBe("cloudru.removeFavorite");
      expect(find(actions, "В избранное")).toBeUndefined();
    });

    it("offers addition when not a favorite", () => {
      const actions = buildNotebookActions(nb({}), false);
      expect(find(actions, "В избранное")?.command).toBe("cloudru.addFavorite");
      expect(find(actions, "Убрать из избранного")).toBeUndefined();
    });
  });
});
