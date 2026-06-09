// Typed errors for the Cloud.ru API layer. Pure module (no `vscode` import) so it is unit-testable.

export type ApiErrorKind =
  | "auth" // 401 — credentials/token invalid or expired
  | "forbidden" // 403
  | "notFound" // 404
  | "rateLimit" // 429
  | "backend" // 5xx
  | "network" // transport failure (no HTTP response)
  | "unknown";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  /** Seconds to wait before retrying, parsed from Retry-After when present (429/503). */
  readonly retryAfterSeconds?: number;
  /** Raw response body (best-effort, for diagnostics). Never contains our own secrets. */
  readonly body?: unknown;

  constructor(
    kind: ApiErrorKind,
    message: string,
    opts: { status?: number; retryAfterSeconds?: number; body?: unknown } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds;
    if (opts.body !== undefined) this.body = opts.body;
  }

  get isAuth(): boolean {
    return this.kind === "auth";
  }
}

function kindForStatus(status: number): ApiErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "notFound";
  if (status === 429) return "rateLimit";
  if (status >= 500) return "backend";
  return "unknown";
}

function messageForKind(kind: ApiErrorKind, status: number, detail: string | undefined): string {
  const suffix = detail ? ` — ${detail}` : "";
  switch (kind) {
    case "auth":
      return `Authentication failed (HTTP ${status}). Check your Cloud.ru access key or sign in again.${suffix}`;
    case "forbidden":
      return `Access denied (HTTP ${status}). Your account lacks permission for this workspace.${suffix}`;
    case "notFound":
      return `Resource not found (HTTP ${status}).${suffix}`;
    case "rateLimit":
      return `Rate limit exceeded (HTTP ${status}). Slow down and retry shortly.${suffix}`;
    case "backend":
      return `Cloud.ru service error (HTTP ${status}). Try again later.${suffix}`;
    default:
      return `Unexpected response (HTTP ${status}).${suffix}`;
  }
}

/** Pull a human-readable detail out of common Cloud.ru/FastAPI error bodies. */
export function extractDetail(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return typeof body === "string" && body.trim() ? body.trim() : undefined;
  }
  const b = body as Record<string, unknown>;
  for (const key of ["detail", "details", "message", "error_message", "error"]) {
    const v = b[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

export function parseRetryAfter(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) return undefined;
  const asSeconds = Number(headerValue);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds;
  const asDate = Date.parse(headerValue);
  if (!Number.isNaN(asDate)) {
    const delta = Math.ceil((asDate - Date.now()) / 1000);
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

/** Build an ApiError from an HTTP response status + parsed body. */
export function apiErrorFromResponse(
  status: number,
  body: unknown,
  retryAfter?: string | null,
): ApiError {
  const kind = kindForStatus(status);
  const detail = extractDetail(body);
  const opts: { status: number; retryAfterSeconds?: number; body?: unknown } = { status };
  const ra = parseRetryAfter(retryAfter);
  if (ra !== undefined) opts.retryAfterSeconds = ra;
  if (body !== undefined) opts.body = body;
  return new ApiError(kind, messageForKind(kind, status, detail), opts);
}
