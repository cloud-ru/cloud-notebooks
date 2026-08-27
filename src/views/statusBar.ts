import * as vscode from "vscode";
import type { WorkspaceContext } from "../api/types";

/**
 * Status-bar item showing the current Cloud.ru workspace (or the signed-out state). Clicking it opens
 * a QuickPick to switch workspace, refresh, or sign out.
 */
export class CloudruStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(
    private readonly deps: {
      isSignedIn: () => Promise<boolean>;
      getWorkspace: () => WorkspaceContext | undefined;
    },
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "cloudru.statusBarMenu";
    this.item.tooltip = "Cloud.ru Distributed Train";
    this.item.show();
  }

  async refresh(): Promise<void> {
    if (!(await this.deps.isSignedIn())) {
      this.item.text = "Cloud.ru: вход не выполнен";
      return;
    }
    const ws = this.deps.getWorkspace();
    this.item.text = `Cloud.ru: ${ws?.workspaceName ?? "воркспейс не выбран"}`;
  }

  dispose(): void {
    this.item.dispose();
  }
}
