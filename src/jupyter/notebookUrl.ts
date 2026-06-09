// Pure helpers for dissecting a notebook URL. No `vscode` → unit-testable.
//
// A notebook URL looks like:
//   https://k2-nb.ai.cloud.ru/a100-mt/notebook/<uuid>/        (server root, base_url = NB_PREFIX)
//   https://k2-nb.ai.cloud.ru/a100-mt/notebook/<uuid>/lab     (lab UI)

export interface NotebookLocation {
  /** Scheme + host, e.g. https://k2-nb.ai.cloud.ru */
  origin: string;
  /** Path prefix the server is mounted under, with leading and trailing slash. */
  prefix: string;
}

/** Split a notebook URL into its origin and server-root path prefix (strips a trailing lab/tree). */
export function parseNotebookUrl(url: string): NotebookLocation {
  const parsed = new URL(url);
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
