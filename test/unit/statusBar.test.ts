import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  StatusBarAlignment: { Left: 1 },
  ThemeColor: class { constructor(public id: string) {} },
  window: { createStatusBarItem: () => ({ show() {}, dispose() {} }) },
}));

import { CloudruStatusBar } from "../../src/views/statusBar";

function setup(state: { signedIn: boolean; expired: boolean; workspace?: string }) {
  const bar = new CloudruStatusBar({
    isSignedIn: async () => state.signedIn,
    isSessionExpired: () => state.expired,
    getWorkspace: () => (state.workspace ? { workspaceId: "id", workspaceName: state.workspace } : undefined),
  });
  const item = (bar as unknown as { item: { text: string; backgroundColor?: { id: string } } }).item;
  return { bar, item };
}

describe("CloudruStatusBar", () => {
  it("keeps an expired session visible as a warning", async () => {
    const { bar, item } = setup({ signedIn: false, expired: true });
    await bar.refresh();
    expect(item.text).toContain("войдите снова");
    expect(item.backgroundColor?.id).toBe("statusBarItem.warningBackground");
  });

  it("shows a plain signed-out state after an explicit sign-out", async () => {
    const { bar, item } = setup({ signedIn: false, expired: false });
    await bar.refresh();
    expect(item.text).toBe("Cloud.ru: вход не выполнен");
    expect(item.backgroundColor).toBeUndefined();
  });

  it("clears the warning once signed in again", async () => {
    const state = { signedIn: false, expired: true, workspace: "Prod" };
    const { bar, item } = setup(state);
    await bar.refresh();
    Object.assign(state, { signedIn: true, expired: false });
    await bar.refresh();
    expect(item.text).toBe("Cloud.ru: Prod");
    expect(item.backgroundColor).toBeUndefined();
  });
});
