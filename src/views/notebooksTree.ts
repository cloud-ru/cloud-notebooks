import * as vscode from "vscode";
import type { ConsoleApiClient } from "../console/apiClient";
import { NotSignedInError } from "../console/tokenProvider";
import { ApiError } from "../api/errors";
import type { NotebookHandlerResponse } from "../api/types";
import type { SessionStore } from "../session/sessionStore";
import type { Logger } from "../util/logger";
import { notebookContextValue, presentNotebookStatus } from "../util/notebookStatus";
import type { FavoritesStore } from "./favoritesStore";
import {
  describeFilter,
  distinctAuthors,
  distinctStatuses,
  filterNotebooks,
  isFilterActive,
  type NotebookFilter,
} from "./notebookFilter";

export interface NotebooksTreeDeps {
  client: ConsoleApiClient;
  session: SessionStore;
  favorites: FavoritesStore;
  isSignedIn: () => Promise<boolean>;
  logger: Logger;
}

/** Tree node carrying the raw notebook so commands can act on it. */
export class NotebookTreeItem extends vscode.TreeItem {
  constructor(
    readonly notebook: NotebookHandlerResponse,
    readonly favorite: boolean,
  ) {
    super(notebook.name, vscode.TreeItemCollapsibleState.None);
    const presentation = presentNotebookStatus(notebook.status);

    this.id = notebook.uid;
    const meta = [notebook.imageDisplayName, notebook.instanceType ?? undefined].filter(Boolean).join(" · ");
    this.description = favorite ? `★ ${meta}` : meta;
    this.iconPath = new vscode.ThemeIcon(
      presentation.icon,
      presentation.color ? new vscode.ThemeColor(presentation.color) : undefined,
    );
    this.contextValue = notebookContextValue(notebook.status) + (favorite ? ".fav" : "");
    this.tooltip = buildTooltip(notebook, favorite);

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

  private filter: NotebookFilter = {};
  private lastNotebooks: NotebookHandlerResponse[] = [];
  private view: vscode.TreeView<NotebookTreeItem> | undefined;

  constructor(private readonly deps: NotebooksTreeDeps) {}

  /** Wire the TreeView so the active filter can be shown as the view message. */
  attachView(view: vscode.TreeView<NotebookTreeItem>): void {
    this.view = view;
    this.syncFilterIndicators();
  }

  refresh(): void {
    this.emitter.fire();
  }

  setSearch(value: string | undefined): void {
    const trimmed = value?.trim();
    if (trimmed) this.filter.search = trimmed;
    else delete this.filter.search;
    this.onFilterChanged();
  }

  setAuthor(value: string | undefined): void {
    if (value) this.filter.author = value;
    else delete this.filter.author;
    this.onFilterChanged();
  }

  setStatuses(values: string[] | undefined): void {
    if (values && values.length) this.filter.statuses = values;
    else delete this.filter.statuses;
    this.onFilterChanged();
  }

  toggleFavoritesOnly(): void {
    if (this.filter.favoritesOnly) delete this.filter.favoritesOnly;
    else this.filter.favoritesOnly = true;
    this.onFilterChanged();
  }

  clearFilters(): void {
    this.filter = {};
    this.onFilterChanged();
  }

  /** Distinct authors from the most recent fetch, for the author-filter picker. */
  authors(): string[] {
    return distinctAuthors(this.lastNotebooks);
  }

  /** Distinct statuses from the most recent fetch, for the status-filter picker. */
  statuses(): string[] {
    return distinctStatuses(this.lastNotebooks);
  }

  /** Statuses currently selected in the filter, for pre-checking the status picker. */
  currentStatuses(): string[] {
    return this.filter.statuses ?? [];
  }

  async toggleFavorite(uid: string): Promise<void> {
    await this.deps.favorites.toggle(uid);
    this.refresh();
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
      this.lastNotebooks = await this.deps.client.listNotebooks(ws);
      const visible = filterNotebooks(this.lastNotebooks, this.filter, (uid) => this.deps.favorites.has(uid));
      return visible.map((nb) => new NotebookTreeItem(nb, this.deps.favorites.has(nb.uid)));
    } catch (err) {
      if (err instanceof NotSignedInError) return []; // provider flips auth + prompts; welcome view takes over
      const message = err instanceof ApiError ? err.message : `Failed to load notebooks: ${String(err)}`;
      this.deps.logger.error("listNotebooks failed", err);
      void vscode.window.showErrorMessage(message);
      return [];
    }
  }

  private onFilterChanged(): void {
    this.syncFilterIndicators();
    this.refresh();
  }

  private syncFilterIndicators(): void {
    if (this.view) this.view.message = describeFilter(this.filter) ?? "";
    void vscode.commands.executeCommand("setContext", "cloudru.hasFilter", isFilterActive(this.filter));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function buildTooltip(nb: NotebookHandlerResponse, favorite: boolean): vscode.MarkdownString {
  const created = nb.creationTimestamp ? new Date(nb.creationTimestamp * 1000).toLocaleString() : "—";
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${nb.name}**${favorite ? " ★" : ""}\n\n`);
  md.appendMarkdown(`- Status: \`${nb.status}\`\n`);
  md.appendMarkdown(`- Image: ${nb.imageDisplayName}\n`);
  md.appendMarkdown(`- Instance: ${nb.instanceType ?? "—"}\n`);
  md.appendMarkdown(`- Region: ${nb.region}\n`);
  md.appendMarkdown(`- Author: ${nb.author}\n`);
  md.appendMarkdown(`- Created: ${created}\n`);
  if (nb.description) md.appendMarkdown(`\n${nb.description}`);
  return md;
}
