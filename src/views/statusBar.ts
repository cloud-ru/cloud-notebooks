import * as vscode from "vscode";
import type { WorkspaceContext } from "../api/types";

const TOOLTIP = "Cloud.ru Distributed Train";

/**
 * Status-bar item showing the current Cloud.ru workspace (or the signed-out state). Clicking it opens
 * a QuickPick to switch workspace, refresh, or sign out — or starts sign-in while signed out.
 */
export class CloudruStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(
    private readonly deps: {
      isSignedIn: () => Promise<boolean>;
      /** The last sign-out was an expired session (not an explicit sign-out). */
      isSessionExpired: () => boolean;
      getWorkspace: () => WorkspaceContext | undefined;
    },
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "cloudru.statusBarMenu";
    this.item.tooltip = TOOLTIP;
    this.item.show();
  }

  async refresh(): Promise<void> {
    if (!(await this.deps.isSignedIn())) {
      // An expired session is a state the user must act on, so it stays visible after the toast fades.
      const expired = this.deps.isSessionExpired();
      this.item.text = expired ? "$(warning) Cloud.ru: войдите снова" : "Cloud.ru: вход не выполнен";
      this.item.tooltip = expired ? "Сессия Cloud.ru истекла — нажмите, чтобы войти" : `${TOOLTIP} — нажмите, чтобы войти`;
      this.item.backgroundColor = expired ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
      return;
    }
    const ws = this.deps.getWorkspace();
    this.item.text = `Cloud.ru: ${ws?.workspaceName ?? "воркспейс не выбран"}`;
    this.item.tooltip = TOOLTIP;
    this.item.backgroundColor = undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
