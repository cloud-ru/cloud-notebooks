import * as vscode from "vscode";
import type { MlSpaceApiClient } from "../api/mlspaceClient";
import { ApiError } from "../api/errors";
import type { NotebookHandlerResponse } from "../api/types";
import type { SessionStore } from "../session/sessionStore";
import type { Logger } from "../util/logger";
import { notebookContextValue, presentNotebookStatus } from "../util/notebookStatus";

export interface NotebooksTreeDeps {
  client: MlSpaceApiClient;
  session: SessionStore;
  isSignedIn: () => Promise<boolean>;
  logger: Logger;
}

/** Tree node carrying the raw notebook so commands can act on it. */
export class NotebookTreeItem extends vscode.TreeItem {
  constructor(readonly notebook: NotebookHandlerResponse) {
    super(notebook.name, vscode.TreeItemCollapsibleState.None);
    const presentation = presentNotebookStatus(notebook.status);

    this.id = notebook.uid;
    this.description = [notebook.imageDisplayName, notebook.instanceType ?? undefined]
      .filter(Boolean)
      .join(" · ");
    this.iconPath = new vscode.ThemeIcon(
      presentation.icon,
      presentation.color ? new vscode.ThemeColor(presentation.color) : undefined,
    );
    this.contextValue = notebookContextValue(notebook.status);
    this.tooltip = buildTooltip(notebook);

    if (presentation.isRunning && notebook.url) {
      this.command = {
        command: "cloudru.openNotebook",
        title: "Open Notebook in VS Code",
        arguments: [this],
      };
    }
  }
}

export class NotebooksTreeProvider implements vscode.TreeDataProvider<NotebookTreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly deps: NotebooksTreeDeps) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: NotebookTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: NotebookTreeItem): Promise<NotebookTreeItem[]> {
    if (element) return []; // flat list

    if (!(await this.deps.isSignedIn())) return [];
    const ws = this.deps.session.get();
    if (!ws) return [];

    try {
      const notebooks = await this.deps.client.listNotebooks(ws);
      return notebooks.map((nb) => new NotebookTreeItem(nb));
    } catch (err) {
      const message = err instanceof ApiError ? err.message : `Failed to load notebooks: ${String(err)}`;
      this.deps.logger.error("listNotebooks failed", err);
      void vscode.window.showErrorMessage(message);
      return [];
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function buildTooltip(nb: NotebookHandlerResponse): vscode.MarkdownString {
  const created = nb.creationTimestamp ? new Date(nb.creationTimestamp * 1000).toLocaleString() : "—";
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${nb.name}**\n\n`);
  md.appendMarkdown(`- Status: \`${nb.status}\`\n`);
  md.appendMarkdown(`- Image: ${nb.imageDisplayName}\n`);
  md.appendMarkdown(`- Instance: ${nb.instanceType ?? "—"}\n`);
  md.appendMarkdown(`- Region: ${nb.region}\n`);
  md.appendMarkdown(`- Author: ${nb.author}\n`);
  md.appendMarkdown(`- Created: ${created}\n`);
  if (nb.description) md.appendMarkdown(`\n${nb.description}`);
  return md;
}
