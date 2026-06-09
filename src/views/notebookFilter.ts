// Pure filtering/sorting for the notebooks tree. No `vscode` → unit-testable.
import type { NotebookHandlerResponse } from "../api/types";

export interface NotebookFilter {
  /** Case-insensitive substring matched against the notebook name. */
  search?: string;
  /** Exact author (creator) match. */
  author?: string;
  /** Show only notebooks marked as favorite. */
  favoritesOnly?: boolean;
}

export function isFilterActive(filter: NotebookFilter): boolean {
  return Boolean(filter.search?.trim() || filter.author || filter.favoritesOnly);
}

/** Apply the filter, then sort favorites first and (within each group) newest first. */
export function filterNotebooks(
  notebooks: NotebookHandlerResponse[],
  filter: NotebookFilter,
  isFavorite: (uid: string) => boolean,
): NotebookHandlerResponse[] {
  const query = filter.search?.trim().toLowerCase();
  const matched = notebooks.filter((nb) => {
    if (query && !nb.name.toLowerCase().includes(query)) return false;
    if (filter.author && nb.author !== filter.author) return false;
    if (filter.favoritesOnly && !isFavorite(nb.uid)) return false;
    return true;
  });

  return matched.sort((a, b) => {
    const favRank = (isFavorite(a.uid) ? 0 : 1) - (isFavorite(b.uid) ? 0 : 1);
    if (favRank !== 0) return favRank;
    return (b.creationTimestamp ?? 0) - (a.creationTimestamp ?? 0);
  });
}

/** Distinct authors present in the list, sorted, for the author-filter picker. */
export function distinctAuthors(notebooks: NotebookHandlerResponse[]): string[] {
  return [...new Set(notebooks.map((nb) => nb.author))].filter(Boolean).sort();
}

/** Short human description of the active filter, or undefined when none. */
export function describeFilter(filter: NotebookFilter): string | undefined {
  const parts: string[] = [];
  if (filter.search?.trim()) parts.push(`name ~ "${filter.search.trim()}"`);
  if (filter.author) parts.push(`author: ${filter.author}`);
  if (filter.favoritesOnly) parts.push("favorites only");
  return parts.length ? `Filtered — ${parts.join(", ")}` : undefined;
}
