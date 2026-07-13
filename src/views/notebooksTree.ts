import * as vscode from "vscode";
import type { ConsoleApiClient } from "../console/apiClient";
import { NotSignedInError } from "../console/tokenProvider";
import { ApiError } from "../api/errors";
import type { NotebookHandlerResponse, NotebookStatus } from "../api/types";
import type { SessionStore } from "../session/sessionStore";
import type { Logger } from "../util/logger";
import { notebookContextValue, presentNotebookStatus, statusLabel } from "../util/notebookStatus";
import type { FavoritesStore } from "./favoritesStore";
import {
  describeFilter,
  distinctAuthors,
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
    const meta = [presentation.label, notebook.imageDisplayName, notebook.instanceType ?? undefined]
      .filter(Boolean)
      .join(" · ");
    this.description = favorite ? `★ ${meta}` : meta;
    this.iconPath = new vscode.ThemeIcon(
      presentation.icon,
      presentation.color ? new vscode.ThemeColor(presentation.color) : undefined,
    );
    this.contextValue = notebookContextValue(notebook.status) + (favorite ? ".fav" : "");
    this.tooltip = buildTooltip(notebook, favorite);

    this.command =
      presentation.isRunning && notebook.url
        ? { command: "cloudru.openNotebook", title: "Открыть в VS Code", arguments: [this] }
        : { command: "cloudru.notebookActions", title: "Действия с ноутбуком", arguments: [this] };
  }
}

export class NotebooksTreeProvider implements vscode.TreeDataProvider<NotebookTreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private filter: NotebookFilter = {};
  private lastNotebooks: NotebookHandlerResponse[] = [];
  private view: vscode.TreeView<NotebookTreeItem> | undefined;
  /** Sign-in-in-progress line (transient); highest priority. */
  private signInMessage: string | undefined;
  /** Last load failure; shown until the next successful fetch. */
  private loadError: string | undefined;
  /** Project-preflight warning; shown until the project is active again / workspace changes. */
  private preflightWarning: string | undefined;
  /** Whether `lastNotebooks` holds a real fetch result yet (vs the empty initial value). */
  private loaded = false;
  /** When true, the next getChildren hits the network; applyNotebooks/poll data clears it so we serve
   * the fresh list without a duplicate fetch (H8/1.4). */
  private refetchNeeded = true;

  constructor(private readonly deps: NotebooksTreeDeps) {}

  /** Wire the TreeView so the active filter can be shown as the view message. */
  attachView(view: vscode.TreeView<NotebookTreeItem>): void {
    this.view = view;
    this.syncFilterIndicators();
  }

  refresh(): void {
    this.refetchNeeded = true;
    this.emitter.fire();
  }

  /** Adopt an externally-fetched list (e.g. from the poll loop) and render it without refetching. */
  applyNotebooks(notebooks: NotebookHandlerResponse[]): void {
    this.lastNotebooks = notebooks;
    this.loaded = true;
    this.refetchNeeded = false;
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

  setStatuses(values: NotebookStatus[] | undefined): void {
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

  /** Status filter options with Russian labels and counts, for the status-filter picker. */
  statusFilterItems(): { status: NotebookStatus; label: string; count: number }[] {
    const counts = new Map<NotebookStatus, number>();
    for (const nb of this.lastNotebooks) counts.set(nb.status, (counts.get(nb.status) ?? 0) + 1);
    return [...counts.entries()]
      .map(([status, count]) => ({ status, label: statusLabel(status), count }))
      .sort((a, b) => a.label.localeCompare(b.label, "ru"));
  }

  /** Statuses currently selected in the filter, for pre-checking the status picker. */
  currentStatuses(): NotebookStatus[] {
    return this.filter.statuses ?? [];
  }

  async toggleFavorite(uid: string): Promise<void> {
    await this.deps.favorites.toggle(uid);
    this.emitter.fire(); // re-render from cache; favorites don't change the fetched list
  }

  isFavorite(uid: string): boolean {
    return this.deps.favorites.has(uid);
  }

  getTreeItem(element: NotebookTreeItem): vscode.TreeItem {
    return element;
  }

  /** Whether the current list has any transient (busy) statuses — drives the auto-refresh cadence. */
  hasBusyNotebooks(): boolean {
    return this.lastNotebooks.some((nb) => presentNotebookStatus(nb.status).isBusy);
  }

  async getChildren(element?: NotebookTreeItem): Promise<NotebookTreeItem[]> {
    if (element) return []; // flat list

    if (!(await this.deps.isSignedIn())) return [];
    const ws = this.deps.session.get();
    if (!ws) return [];

    if (this.refetchNeeded || !this.loaded) {
      try {
        this.lastNotebooks = await this.deps.client.listNotebooks(ws);
        this.loaded = true;
        this.refetchNeeded = false;
        this.loadError = undefined;
        void vscode.commands.executeCommand("setContext", "cloudru.loadError", false);
        this.syncFilterIndicators();
      } catch (err) {
        if (err instanceof NotSignedInError) return []; // provider flips auth + prompts; welcome takes over
        const message = err instanceof ApiError ? err.message : `Не удалось загрузить ноутбуки: ${String(err)}`;
        this.deps.logger.error("listNotebooks failed", err);
        this.loadError = message;
        void vscode.commands.executeCommand("setContext", "cloudru.loadError", true);
        this.syncFilterIndicators();
        return this.render();
      }
    }
    return this.render();
  }

  private render(): NotebookTreeItem[] {
    const visible = filterNotebooks(this.lastNotebooks, this.filter, (uid) => this.deps.favorites.has(uid));
    return visible.map((nb) => new NotebookTreeItem(nb, this.deps.favorites.has(nb.uid)));
  }

  private onFilterChanged(): void {
    this.syncFilterIndicators();
    this.emitter.fire(); // re-render cached list with the new filter; no refetch
  }

  /** Sign-in progress line (or clear with undefined). Highest-priority view message. */
  setSignInMessage(message: string | undefined): void {
    this.signInMessage = message;
    this.syncFilterIndicators();
  }

  /** Project-preflight warning (or clear with undefined). */
  setPreflightWarning(message: string | undefined): void {
    this.preflightWarning = message;
    this.syncFilterIndicators();
  }

  private syncFilterIndicators(): void {
    if (this.view) {
      this.view.message =
        this.signInMessage ?? this.loadError ?? this.preflightWarning ?? describeFilter(this.filter) ?? "";
    }
    void vscode.commands.executeCommand("setContext", "cloudru.hasFilter", isFilterActive(this.filter));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

const ACCESS_MODE_LABELS: Record<string, string> = {
  private: "индивидуальный",
  shared: "совместный",
  multiuser: "мультидоступ",
};

function buildTooltip(nb: NotebookHandlerResponse, favorite: boolean): vscode.MarkdownString {
  const created = nb.creationTimestamp ? new Date(nb.creationTimestamp * 1000).toLocaleString() : "—";
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${nb.name}**${favorite ? " ★" : ""}\n\n`);
  md.appendMarkdown(`- Статус: ${statusLabel(nb.status)}\n`);
  md.appendMarkdown(`- Образ: ${nb.imageDisplayName}\n`);
  md.appendMarkdown(`- Инстанс: ${nb.instanceType ?? "—"}\n`);
  md.appendMarkdown(`- Регион: ${nb.region}\n`);
  md.appendMarkdown(`- Автор: ${nb.author}\n`);
  md.appendMarkdown(`- Создан: ${created}\n`);
  if (nb.allocationName) md.appendMarkdown(`- Аллокация: ${nb.allocationName}\n`);
  const access = nb.accessMode ? ACCESS_MODE_LABELS[nb.accessMode] : undefined;
  if (access) md.appendMarkdown(`- Доступ: ${access}\n`);
  if (nb.autoshutdownModes && nb.autoshutdownModes.length) {
    md.appendMarkdown(`- Автовыключение: ${nb.autoshutdownModes.join(", ")}\n`);
  }
  if (nb.pause_at) md.appendMarkdown(`- Пауза запланирована: ${nb.pause_at}\n`);
  if (nb.description) md.appendMarkdown(`\n${nb.description}`);
  return md;
}
