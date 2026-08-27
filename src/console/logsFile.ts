// Pure helpers for the notebook logs download endpoint (GET /notebooks/v2/{ns}/{name}/logs/download).
// No `vscode`/network imports → unit-testable.

/**
 * Parse the archive file name from a `Content-Disposition` header, falling back to
 * `<notebookName>.txt` (mirrors the web app). Handles both RFC 5987 (`filename*=UTF-8''…`) and the
 * plain quoted form.
 */
export function parseDownloadFileName(header: string | null | undefined, notebookName: string): string {
  const fallback = `${notebookName}.txt`;
  if (!header) return fallback;
  const utf8 = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1]) || fallback;
    } catch {
      return fallback;
    }
  }
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain?.[1]?.trim() || fallback;
}

/** ISO string of the instant `daysAgo` days before now ("start_date" param). */
export function isoDaysAgo(daysAgo: number, now: number = Date.now()): string {
  return new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}
