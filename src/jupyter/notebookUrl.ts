// Pure helpers for dissecting a notebook URL. No `vscode` → unit-testable.
//
// The backend returns `notebook.url` in one of two formats:
//   legacy, absolute, server mounted under a path prefix (base_url = NB_PREFIX):
//     https://k2-nb.ai.cloud.ru/a100-mt/notebook/<uuid>/        (server root)
//     https://k2-nb.ai.cloud.ru/a100-mt/notebook/<uuid>/lab     (lab UI)
//   new, a bare host without a scheme, server mounted at "/":
//     <name>-<uuid>.sr004-nb.ai.cloud.ru

export interface NotebookLocation {
  /** Scheme + host, e.g. https://k2-nb.ai.cloud.ru */
  origin: string;
  /** Path prefix the server is mounted under, with leading and trailing slash. */
  prefix: string;
}

/**
 * Absolute form of a `notebook.url` in either backend format: a legacy `http(s)://` URL is kept as is,
 * a bare host gets `https://` and a single trailing slash (same rule as the console's
 * `buildNotebookConnectUrl`).
 */
export function toAbsoluteNotebookUrl(url: string): string {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/\/+$/, "")}/`;
}

/** Split a notebook URL into its origin and server-root path prefix (strips a trailing lab/tree). */
export function parseNotebookUrl(url: string): NotebookLocation {
  const parsed = new URL(toAbsoluteNotebookUrl(url));
  let path = parsed.pathname;
  // Drop a trailing UI segment so the prefix points at the server root that serves /api/*.
  path = path.replace(/\/(lab|tree)\/?$/, "/");
  if (!path.endsWith("/")) path += "/";
  if (!path.startsWith("/")) path = `/${path}`;
  return { origin: parsed.origin, prefix: path };
}

/** Path (no origin) of the lab UI for an iframe src, e.g. /a100-mt/notebook/<uuid>/lab */
export function labPath(prefix: string): string {
  return `${prefix}lab`;
}
