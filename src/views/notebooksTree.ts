import * as vscode from "vscode";
import type { ConsoleApiClient } from "../console/apiClient";
import { NotSignedInError } from "../console/tokenProvider";
import { ApiError } from "../api/errors";
import type { NotebookHandlerResponse, NotebookStatus } from "../api/types";
import type { SessionStore } from "../session/sessionStore";
import type { Logger } from "../util/logger";
import { notebookContextValue, presentNotebookStatus, statusLabel } from "../util/notebookStatus";
import { hasBucketMountProblem } from "../console/notebookMapping";
import type { FavoritesStore } from "./favoritesStore";
import { buildNotebookActions } from "./notebookActions";
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
  /** Synchronous so the view message can be cleared in the same tick the auth state flips. */
  isSignedIn: () => boolean;
  logger: Logger;
}

type DataState = {
  kind: "ready" | "refreshing" | "stale";
  generation: number;
  notebooks: NotebookHandlerResponse[];
  error?: string;
};
type LoadState = { kind: "idle" | "loading"; generation: number } |
  { kind: "error"; generation: number; error: string } | DataState;

function hasData(state: LoadState): state is DataState {
  return "notebooks" in state;
}

/** Tree node carrying the raw notebook so commands can act on it. */
export class NotebookTreeItem extends vscode.TreeItem {
  constructor(
    readonly notebook: NotebookHandlerResponse,
    readonly favorite: boolean,
    readonly contextGeneration: number,
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
    this.contextValue = notebookContextValue(notebook.status)
      + (notebook.accessGranted === false ? ".denied" : "")
      + (!notebook.url ? ".noUrl" : "")
      + (notebook.status === "deleted" ? ".deleted" : "")
      + (notebook.region === "DGX2_MT" ? ".dgx2" : "")
      + (favorite ? ".fav" : "");
    this.tooltip = buildTooltip(notebook, favorite);

    this.command =
      buildNotebookActions(notebook, favorite).some((action) => action.command === "cloudru.openNotebook")
        ? { command: "cloudru.openNotebook", title: "Открыть в VS Code", arguments: [this] }
        : { command: "cloudru.notebookActions", title: "Действия с ноутбуком", arguments: [this] };
  }
}

export class NotebooksTreeProvider implements vscode.TreeDataProvider<NotebookTreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private filter: NotebookFilter = {};
  private state: LoadState;
  private view: vscode.TreeView<NotebookTreeItem> | undefined;
  /** Sign-in-in-progress line (transient); highest priority. */
  private signInMessage: string | undefined;
  /** Project-preflight warning; shown until the project is active again / workspace changes. */
  private preflightWarning: string | undefined;
  constructor(private readonly deps: NotebooksTreeDeps) {
    this.state = { kind: "idle", generation: deps.session.getGeneration() };
  }

  /** Wire the TreeView so the active filter can be shown as the view message. */
  attachView(view: vscode.TreeView<NotebookTreeItem>): void {
    this.view = view;
    this.syncFilterIndicators();
  }

  refresh(): void {
    this.syncContext();
    if (!this.canLoad()) {
      // Signed out or no workspace: nothing will load, so a "loading" state would never settle.
      this.state = { kind: "idle", generation: this.state.generation };
    } else {
      this.state = hasData(this.state)
        ? { ...this.state, kind: "refreshing" }
        : { kind: "loading", generation: this.state.generation };
    }
    this.syncFilterIndicators();
    this.emitter.fire();
  }

  private canLoad(): boolean {
    return this.deps.isSignedIn() && Boolean(this.deps.session.get());
  }

  /** Adopt an externally-fetched list (e.g. from the poll loop) and render it without refetching. */
  applyNotebooks(notebooks: NotebookHandlerResponse[], generation: number): void {
    this.syncContext();
    if (generation !== this.state.generation) return;
    this.state = { kind: "ready", generation, notebooks };
    void vscode.commands.executeCommand("setContext", "cloudru.loadError", false);
    this.syncFilterIndicators();
    this.emitter.fire();
  }

  /** Hide the previous context's rows synchronously when auth or workspace changes. */
  resetContext(): void {
    this.state = { kind: "idle", generation: this.deps.session.getGeneration() };
    this.preflightWarning = undefined;
    delete this.filter.author;
    void vscode.commands.executeCommand("setContext", "cloudru.loadError", false);
    this.syncFilterIndicators();
    this.emitter.fire();
  }

  private syncContext(): void {
    if (this.state.generation !== this.deps.session.getGeneration()) this.resetContext();
  }

  private notebooks(): NotebookHandlerResponse[] {
    this.syncContext();
    return hasData(this.state) ? this.state.notebooks : [];
  }

  setSearch(value: string | undefined): void {
    const trimmed = value?.trim();
    if (trimmed) this.filter.search = trimmed;
    else delete this.filter.search;
    this.onFilterChanged();
  }

  currentSearch(): string {
    return this.filter.search ?? "";
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
    return distinctAuthors(this.notebooks());
  }

  /** Status filter options with Russian labels and counts, for the status-filter picker. */
  statusFilterItems(): { status: NotebookStatus; label: string; count: number }[] {
    const counts = new Map<NotebookStatus, number>();
    for (const nb of this.notebooks()) counts.set(nb.status, (counts.get(nb.status) ?? 0) + 1);
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
    return this.notebooks().some((nb) => presentNotebookStatus(nb.status).isBusy);
  }

  async getChildren(element?: NotebookTreeItem): Promise<NotebookTreeItem[]> {
    if (element) return []; // flat list
    this.syncContext();
    const generation = this.state.generation;
    const ws = this.deps.session.get();
    if (!ws || !this.deps.isSignedIn()) {
      this.settleIdle();
      return [];
    }

    if (this.state.kind !== "ready") {
      this.state = hasData(this.state)
        ? { ...this.state, kind: "refreshing" }
        : { kind: "loading", generation };
      const requestState = this.state;
      this.syncFilterIndicators();
      try {
        const notebooks = await this.deps.client.listNotebooks(ws);
        if (generation !== this.deps.session.getGeneration()) return [];
        if (this.state === requestState) this.applyNotebooks(notebooks, generation);
      } catch (err) {
        if (generation !== this.deps.session.getGeneration()) return [];
        if (this.state !== requestState) return this.render();
        if (err instanceof NotSignedInError) {
          this.settleIdle(); // provider flips auth + prompts; the welcome view takes over
          return [];
        }
        const message = err instanceof ApiError ? err.message : `Не удалось загрузить ноутбуки: ${String(err)}`;
        this.deps.logger.error("listNotebooks failed", err);
        this.state = hasData(this.state)
          ? { ...this.state, kind: "stale", error: message }
          : { kind: "error", generation, error: message };
        void vscode.commands.executeCommand("setContext", "cloudru.loadError", this.state.kind === "error");
        this.syncFilterIndicators();
        return this.render();
      }
    }
    return this.render();
  }

  /** Nothing is going to load: drop a pending "loading" so its message stops covering the welcome. */
  private settleIdle(): void {
    if (this.state.kind === "idle") return;
    this.state = { kind: "idle", generation: this.state.generation };
    this.syncFilterIndicators();
  }

  private render(): NotebookTreeItem[] {
    const visible = filterNotebooks(this.notebooks(), this.filter, (uid) => this.deps.favorites.has(uid));
    return visible.map((nb) => new NotebookTreeItem(nb, this.deps.favorites.has(nb.uid), this.state.generation));
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
  setPreflightWarning(message: string | undefined, generation = this.deps.session.getGeneration()): void {
    this.syncContext();
    if (generation !== this.state.generation) return;
    this.preflightWarning = message;
    this.syncFilterIndicators();
  }

  private syncFilterIndicators(): void {
    const filtered = isFilterActive(this.filter);
    const notebooks = hasData(this.state) ? this.state.notebooks : [];
    const visibleCount = filterNotebooks(notebooks, this.filter, (uid) => this.deps.favorites.has(uid)).length;
    if (this.view) {
      const error = this.state.kind === "error" || this.state.kind === "stale" ? this.state.error : undefined;
      const stateMessage = this.state.kind === "loading" ? "Загружаем ноутбуки…" :
        this.state.kind === "stale" ? `Не удалось обновить; показаны сохранённые данные. ${error}` : error;
      // A silent token refresh behind rows already on screen needs no explanation; an empty view does.
      const signInMessage = hasData(this.state) ? undefined : this.signInMessage;
      const filterMessage = filtered ? `${describeFilter(this.filter)} · ${visibleCount} из ${notebooks.length}` : undefined;
      // VS Code hides the welcome view whenever a message is set, and while signed out or without a
      // workspace the welcome view holds the only way forward (its sign-in / pick-workspace button).
      this.view.message = this.canLoad()
        ? [signInMessage ?? stateMessage, this.preflightWarning, filterMessage].filter(Boolean).join(" · ")
        : "";
    }
    void vscode.commands.executeCommand("setContext", "cloudru.hasFilter", filtered);
    void vscode.commands.executeCommand("setContext", "cloudru.loading", this.state.kind === "idle" || this.state.kind === "loading");
    void vscode.commands.executeCommand("setContext", "cloudru.filteredEmpty", filtered && hasData(this.state) && visibleCount === 0);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

const ACCESS_MODE_LABELS: Record<string, string> = {
  private: "индивидуальный",
  shared: "совместный",
  multiuser: "многопользовательский",
};

function buildTooltip(nb: NotebookHandlerResponse, favorite: boolean): vscode.MarkdownString {
  const created = nb.creationTimestamp ? new Date(nb.creationTimestamp * 1000).toLocaleString() : "—";
  const md = new vscode.MarkdownString(undefined, true);
  const line = (label: string, value: string) => {
    md.appendMarkdown(`- ${label}: `);
    md.appendText(value);
    md.appendMarkdown("\n");
  };
  md.appendMarkdown("**");
  md.appendText(nb.name);
  md.appendMarkdown(`**${favorite ? " ★" : ""}\n\n`);
  line("Статус", statusLabel(nb.status));
  line("Образ", nb.imageDisplayName);
  line("Инстанс", nb.instanceType ?? "—");
  line("Регион", nb.region);
  line("Автор", nb.author);
  line("Создан", created);
  if (nb.allocationName) line("Аллокация", nb.allocationName);
  const access = nb.accessMode ? ACCESS_MODE_LABELS[nb.accessMode] : undefined;
  if (access) line("Доступ", access);
  if (nb.autoshutdownModes && nb.autoshutdownModes.length) {
    line("Автовыключение", nb.autoshutdownModes.join(", "));
  }
  if (nb.pause_at) line("Пауза запланирована", nb.pause_at);
  // The pod hit a node problem and will be restarted automatically (mirrors the console alert).
  if (nb.restartTimestamp) {
    md.appendMarkdown(`\n⚠️ Неполадка узла: сервер будет перезапущен ${new Date(nb.restartTimestamp).toLocaleString()}.\n`);
  }
  if (hasBucketMountProblem(nb)) {
    md.appendMarkdown("\n⚠️ Бакет не смонтирован — нет доступа или бакет не существует.\n");
  }
  if (nb.description) { md.appendMarkdown("\n"); md.appendText(nb.description); }
  return md;
}
