import * as vscode from "vscode";

const KEY = "cloudru.favorites";

/** Persists the set of favorite notebook uids in global state (survives across workspaces/restarts). */
export class FavoritesStore {
  private readonly favorites: Set<string>;

  constructor(private readonly memento: vscode.Memento) {
    this.favorites = new Set(memento.get<string[]>(KEY, []));
  }

  has(uid: string): boolean {
    return this.favorites.has(uid);
  }

  /** Toggle and persist; returns the new favorite state. */
  async toggle(uid: string): Promise<boolean> {
    const next = !this.favorites.has(uid);
    await this.set(uid, next);
    return next;
  }

  async set(uid: string, favorite: boolean): Promise<void> {
    if (favorite) this.favorites.add(uid);
    else this.favorites.delete(uid);
    await this.memento.update(KEY, [...this.favorites]);
  }
}
