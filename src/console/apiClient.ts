// Client for the Cloud.ru console UI backend (console.cloud.ru/aicloud/ui) — the same API the web app
// uses. Authenticated with an OIDC Bearer (+ x-workspace-id for workspace-scoped calls). Requests go
// through `consoleFetch` (system-CA-trusting https) rather than the global fetch, which fails behind a
// corporate TLS-inspection proxy. No `vscode` import → unit-testable with an injected fetch.
import { ApiError, apiErrorFromResponse } from "../api/errors";
import type { NotebookHandlerResponse, WorkspaceContext } from "../api/types";
import { consoleFetch, type HttpFetch, type HttpResponse } from "./consoleHttp";
import { type ConsoleNotebooksResponse, mapConsoleNotebook } from "./notebookMapping";

const NAMESPACE_HEADER = "cp-front-mlspace-env-jupyter-server";

/** Workspace list item from GET /user/v1/workspaces/ — the console "switcher" list (flat, all of the
 * user's workspaces). `workspace_id` becomes the x-workspace-id header. */
export interface ConsoleWorkspace {
  workspace_id: string;
  workspace_name: string;
  workspace_status?: string;
  namespace?: string;
  project_name?: string;
  email?: string;
}

/** One region entry from GET /jup_web_app/v3/notebooks/config — keyed by `key` (matches a notebook's
 * `region`, e.g. `SR008`, `A100-MT`), carrying the gateway `ssh` block (null for SSH-less regions). */
interface SshConfigRegion {
  key?: string;
  ssh?: { url?: string; port?: string | number } | null;
}

/** SSH gateway coordinates resolved for a notebook's region. `port` is a string in the API; parsed. */
export interface SshGatewayConfig {
  url: string;
  port?: number;
}

export interface ConsoleApiClientOptions {
  /** Console UI backend base, e.g. https://console.cloud.ru/aicloud/ui */
  baseUrl: string;
  getToken: (forceRefresh?: boolean) => Promise<string>;
  /** Injected for tests; defaults to the system-CA-trusting https client. */
  fetchImpl?: HttpFetch;
  /** Optional channel for request diagnostics (e.g. the SSH-config response shape). */
  logger?: { info(message: string): void };
}

export class ConsoleApiClient {
  private readonly baseUrl: string;
  private readonly getToken: (forceRefresh?: boolean) => Promise<string>;
  private readonly fetchImpl: HttpFetch;
  private readonly logger: { info(message: string): void } | undefined;

  constructor(opts: ConsoleApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.getToken = opts.getToken;
    this.fetchImpl = opts.fetchImpl ?? consoleFetch;
    this.logger = opts.logger;
  }

  /** All workspaces the signed-in user belongs to. Bootstrap call — no x-workspace-id. */
  async listWorkspaces(): Promise<ConsoleWorkspace[]> {
    const res = await this.send<ConsoleWorkspace[]>("GET", `${this.baseUrl}/user/v1/workspaces/`, {});
    return Array.isArray(res) ? res : [];
  }

  async listNotebooks(ws: WorkspaceContext): Promise<NotebookHandlerResponse[]> {
    const res = await this.send<ConsoleNotebooksResponse>(
      "GET",
      `${this.baseUrl}/notebooks/v2/?include_private=true`,
      { workspaceId: ws.workspaceId },
    );
    return (res.notebooks ?? []).map(mapConsoleNotebook);
  }

  async pauseNotebook(ws: WorkspaceContext, uid: string): Promise<void> {
    await this.send<unknown>("POST", `${this.baseUrl}/notebooks/v4/${uid}/pause`, {
      workspaceId: ws.workspaceId,
    });
  }

  async resumeNotebook(ws: WorkspaceContext, namespace: string, body: unknown): Promise<void> {
    await this.send<unknown>(
      "POST",
      `${this.baseUrl}/jup_web_app/v3/notebooks/${namespace}/resume_request`,
      { workspaceId: ws.workspaceId, body },
    );
  }

  /** SSH gateway host/port for a notebook's region. The config endpoint returns every region (each
   * with a `key` and an `ssh` block); we pick the one whose `key` matches `regionKey` (the notebook's
   * `region`). Returns undefined when there is no matching region with a host. */
  async getSshGatewayConfig(
    ws: WorkspaceContext,
    regionType: string,
    regionKey: string,
  ): Promise<SshGatewayConfig | undefined> {
    const res = await this.send<{ regions?: SshConfigRegion[]; quantumImages?: SshConfigRegion[] }>(
      "GET",
      `${this.baseUrl}/jup_web_app/v3/notebooks/config?region_type=${encodeURIComponent(regionType)}`,
      { workspaceId: ws.workspaceId },
    );
    const regions = [...(res.regions ?? []), ...(res.quantumImages ?? [])];
    const match = regions.find((r) => r.key?.toLowerCase() === regionKey.toLowerCase());
    this.logger?.info(
      `[ssh] notebooks/config: region "${regionKey}" → ${match?.ssh?.url ?? "—"} ` +
        `(available: ${regions.map((r) => r.key).filter(Boolean).join(", ")})`,
    );
    const url = match?.ssh?.url;
    if (!url) return undefined;
    const port = Number(match.ssh?.port);
    return Number.isFinite(port) && port > 0 ? { url, port } : { url };
  }

  private async send<T>(
    method: "GET" | "POST",
    url: string,
    opts: { workspaceId?: string; body?: unknown },
  ): Promise<T> {
    // The console OIDC token lives only a few minutes. On a 401 the cached token has expired
    // server-side (or was revoked); force a silent re-mint and retry once before surfacing an
    // auth error, so a stale token recovers transparently instead of dropping the session.
    let response = await this.dispatch(method, url, opts, false);
    if (response.status === 401) {
      response = await this.dispatch(method, url, opts, true);
    }

    const raw = await response.text();
    const parsed = raw ? safeJsonParse(raw) : undefined;
    if (!response.ok) {
      throw apiErrorFromResponse(response.status, parsed ?? raw, response.headers.get("retry-after"));
    }
    return parsed as T;
  }

  private async dispatch(
    method: "GET" | "POST",
    url: string,
    opts: { workspaceId?: string; body?: unknown },
    forceRefreshToken: boolean,
  ): Promise<HttpResponse> {
    const token = await this.getToken(forceRefreshToken);
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "front-initiator-namespace": NAMESPACE_HEADER,
    };
    if (opts.workspaceId) headers["x-workspace-id"] = opts.workspaceId;
    const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    try {
      return await this.fetchImpl(url, init);
    } catch (cause) {
      const detail = (cause as { cause?: unknown })?.cause ?? cause;
      throw new ApiError("network", `Network error contacting the Cloud.ru console: ${String(detail)}`);
    }
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
