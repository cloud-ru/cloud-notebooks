// Client for the Cloud.ru console UI backend (console.cloud.ru/aicloud/ui) — the same API the web app
// uses. Authenticated with an OIDC Bearer (+ x-workspace-id for workspace-scoped calls). Requests go
// through `consoleFetch` (system-CA-trusting https) rather than the global fetch, which fails behind a
// corporate TLS-inspection proxy. No `vscode` import → unit-testable with an injected fetch.
import { ApiError, apiErrorFromResponse } from "../api/errors";
import type { NotebookHandlerResponse, NotebookLogs, ProjectStatus, SshKeyPair, WorkspaceContext } from "../api/types";
import { consoleFetch, type HttpFetch, type HttpResponse } from "./consoleHttp";
import { parseDownloadFileName as dispositionFileName } from "./logsFile";
import { type ConsoleNotebooksResponse, mapConsoleNotebook } from "./notebookMapping";
import type { ResolvedHarborImage } from "./resumeBody";

const NAMESPACE_HEADER = "cp-front-mlspace-env-jupyter-server";

/**
 * Editable fields of a notebook (POST /notebooks/v2/{uid}/modify). The backend treats the payload as
 * the full replacement for these fields, so callers echo back current values they keep unchanged
 * (same contract as the web console's modify mutation).
 */
export interface ModifyNotebookPayload {
  description?: string;
  s3_buckets?: { bucket_name: string; access_rule?: string }[];
  /** Raw autoshutdown config DTO (by_timer/by_schedule/by_load); null disables it entirely. */
  autoshutdown_config?: unknown;
}

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
  /** Optional channel for request diagnostics (SSH-config shape, unknown statuses). */
  logger?: { info(message: string): void; warn?(message: string): void };
  /** Per-request timeout in ms (defaults to consoleHttp's DEFAULT_HTTP_TIMEOUT_MS). Shrinkable in tests. */
  timeoutMs?: number;
  /** Called once a request still returns 401 after forced token refresh. */
  onAuthFailure?: () => Promise<void>;
}

export class ConsoleApiClient {
  private readonly baseUrl: string;
  private readonly getToken: (forceRefresh?: boolean) => Promise<string>;
  private readonly fetchImpl: HttpFetch;
  private readonly logger: { info(message: string): void; warn?(message: string): void } | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly onAuthFailure: (() => Promise<void>) | undefined;
  /** In-flight listNotebooks calls keyed by workspaceId, so the tree, kernel provider and poller share
   * one request instead of racing three concurrent silent mints. */
  private readonly inFlightList = new Map<string, Promise<NotebookHandlerResponse[]>>();

  /** Prevent a new auth/workspace context from joining an older list request. */
  invalidateContext(): void {
    this.inFlightList.clear();
  }

  constructor(opts: ConsoleApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.getToken = opts.getToken;
    this.fetchImpl = opts.fetchImpl ?? consoleFetch;
    this.logger = opts.logger;
    this.timeoutMs = opts.timeoutMs;
    this.onAuthFailure = opts.onAuthFailure;
  }

  /** All workspaces the signed-in user belongs to. Bootstrap call — no x-workspace-id. */
  async listWorkspaces(): Promise<ConsoleWorkspace[]> {
    const res = await this.send<unknown>("GET", `${this.baseUrl}/user/v1/workspaces/`, {});
    if (!Array.isArray(res) || !res.every((ws) => ws && typeof ws.workspace_id === "string" && typeof ws.workspace_name === "string")) {
      throw new ApiError("unknown", "Cloud.ru returned an invalid workspace list");
    }
    return res as ConsoleWorkspace[];
  }

  async listNotebooks(ws: WorkspaceContext, signal?: AbortSignal): Promise<NotebookHandlerResponse[]> {
    const existing = this.inFlightList.get(ws.workspaceId);
    if (existing) return signal ? waitForSubscriber(existing, signal) : existing;
    const request = this.send<unknown>(
      "GET",
      `${this.baseUrl}/notebooks/v2/?include_private=true`,
      { workspaceId: ws.workspaceId },
    )
      .then((res) => {
        if (!isNotebookList(res)) throw new ApiError("unknown", "Cloud.ru returned an invalid notebook list");
        return res.notebooks.map((n) =>
          mapConsoleNotebook(n, (raw) => this.logger?.warn?.(`[status] unrecognized notebook status "${raw}" → unknown`)),
        );
      })
      .finally(() => {
        if (this.inFlightList.get(ws.workspaceId) === request) this.inFlightList.delete(ws.workspaceId);
      });
    this.inFlightList.set(ws.workspaceId, request);
    return signal ? waitForSubscriber(request, signal) : request;
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

  /**
   * Look up a datahub/default Jupyter image by name+tag to recover its labels for the resume body.
   * Mirrors the web app's docker_images lookup. Returns undefined when nothing matches;
   * callers treat any failure as "no match" and fall back to empty labels — never blocking resume.
   */
  async findResumeImage(
    ws: WorkspaceContext,
    params: { region: string; imageName: string; tag: string },
  ): Promise<ResolvedHarborImage | undefined> {
    const body = {
      region_type: "MT",
      filters: [
        { field: "type", values: ["datahub", "default"] },
        { field: "name", values: [params.imageName] },
        { field: "tag", values: [params.tag] },
      ],
      labels: { "mlspace.image.capabilities": ["Jupyter"], "mlspace.cluster.keys": [params.region] },
    };
    const res = await this.send<unknown>("POST", `${this.baseUrl}/ar_mgmt/v1/docker_images`, {
      workspaceId: ws.workspaceId,
      body,
    });
    return firstResumeImage(res);
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

  /** Delete a notebook (async — poll the list until it disappears). */
  async deleteNotebook(ws: WorkspaceContext, uid: string): Promise<void> {
    await this.send<unknown>("DELETE", `${this.baseUrl}/notebooks/v4/${uid}`, { workspaceId: ws.workspaceId });
  }

  /**
   * Edit an existing notebook (POST /notebooks/v2/{uid}/modify). The backend replaces the editable
   * fields wholesale, so callers must echo back the current values they do not intend to change —
   * that is why the payload carries description, s3_buckets and autoshutdown_config together.
   */
  async modifyNotebook(ws: WorkspaceContext, uid: string, body: ModifyNotebookPayload): Promise<void> {
    await this.send<unknown>("POST", `${this.baseUrl}/notebooks/v2/${encodeURIComponent(uid)}/modify`, {
      workspaceId: ws.workspaceId,
      body,
    });
  }

  /** Upload the user's own public SSH key (invalidates any previously provisioned key). */
  async uploadUserPublicKey(ws: WorkspaceContext, publicKey: string): Promise<void> {
    await this.send<unknown>("POST", `${this.baseUrl}/user/v1/user_ssh_keys/public_key`, {
      workspaceId: ws.workspaceId,
      body: { public_key: publicKey.trim() },
    });
  }

  /**
   * Download notebook logs as text. `startDate`/`stopDate` are ISO strings; pass undefined to get
   * everything available. The raw text is returned together with the file name suggested by the
   * server (Content-Disposition), falling back to `<notebookName>.txt`.
   */
  async downloadNotebookLogs(
    ws: WorkspaceContext,
    params: { namespace: string; notebookName: string; region: string; startDate?: string; stopDate?: string },
  ): Promise<{ fileName: string; content: string }> {
    const query = new URLSearchParams({ region: params.region });
    if (params.startDate !== undefined) query.set("start_date", params.startDate);
    if (params.stopDate !== undefined) query.set("stop_date", params.stopDate);
    query.set("asc", "true");
    const url =
      `${this.baseUrl}/notebooks/v2/${encodeURIComponent(params.namespace)}` +
      `/${encodeURIComponent(params.notebookName)}/logs/download?${query.toString()}`;
    // One-off request bypassing send(): this endpoint answers with a text attachment, not JSON.
    // Same auth policy as send(): one forced re-mint + retry after a 401.
    let response = await this.dispatch("GET", url, { workspaceId: ws.workspaceId }, false);
    if (response.status === 401) {
      response = await this.dispatch("GET", url, { workspaceId: ws.workspaceId }, true);
    }
    if (response.status === 401) await this.onAuthFailure?.();
    if (!response.ok) {
      throw apiErrorFromResponse(response.status, await response.text(), response.headers.get("retry-after"));
    }
    return {
      fileName: dispositionFileName(response.headers.get("content-disposition"), params.notebookName),
      content: await response.text(),
    };
  }

  /** Notebook logs + current status/reason. `namespace` is the workspace namespace (as for resume). */
  async getNotebookLogs(
    ws: WorkspaceContext,
    namespace: string,
    notebookName: string,
    region: string,
  ): Promise<NotebookLogs> {
    const res = await this.send<Partial<NotebookLogs>>(
      "GET",
      `${this.baseUrl}/notebooks/v2/${encodeURIComponent(namespace)}/${encodeURIComponent(notebookName)}` +
        `/logs?region=${encodeURIComponent(region)}`,
      { workspaceId: ws.workspaceId },
    );
    return {
      logs: res.logs ?? "",
      notebook_status: res.notebook_status ?? "",
      status_reason: res.status_reason ?? "",
    };
  }

  /** Project preflight: whether the workspace's project can run/connect notebooks. Missing/blank
   * response is treated as active so the UI is never blocked on a flaky preflight (mirrors the web). */
  async getProjectStatus(ws: WorkspaceContext): Promise<ProjectStatus> {
    const res = await this.send<Partial<ProjectStatus>>("GET", `${this.baseUrl}/notebooks/v2/preflight`, {
      workspaceId: ws.workspaceId,
    });
    return { access: res.access ?? true, ...(res.rejection ? { rejection: res.rejection } : {}) };
  }

  /** The user's existing Distributed Train SSH key pair, or undefined if none is provisioned. */
  async getSshKey(ws: WorkspaceContext): Promise<SshKeyPair | undefined> {
    const res = await this.send<Partial<SshKeyPair>>("GET", `${this.baseUrl}/user/v1/user_ssh_keys/`, {
      workspaceId: ws.workspaceId,
    });
    if (!res.private_key && !res.public_key) return undefined;
    return { public_key: res.public_key ?? "", private_key: res.private_key ?? "" };
  }

  /** Generate a fresh SSH key pair (invalidates the previous one). Returns the private key. */
  async generateSshKey(ws: WorkspaceContext): Promise<SshKeyPair> {
    const res = await this.send<Partial<SshKeyPair>>("POST", `${this.baseUrl}/user/v1/user_ssh_keys/generate`, {
      workspaceId: ws.workspaceId,
    });
    return { public_key: res.public_key ?? "", private_key: res.private_key ?? "" };
  }

  private async send<T>(
    method: "GET" | "POST" | "DELETE",
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
    if (response.status === 401) await this.onAuthFailure?.();

    const raw = await response.text();
    const parsed = raw ? safeJsonParse(raw) : undefined;
    if (!response.ok) {
      throw apiErrorFromResponse(response.status, parsed ?? raw, response.headers.get("retry-after"));
    }
    if (raw && parsed === undefined) throw new ApiError("unknown", "Cloud.ru returned invalid JSON");
    return parsed as T;
  }

  private async dispatch(
    method: "GET" | "POST" | "DELETE",
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
    const init: { method: string; headers: Record<string, string>; body?: string; timeoutMs?: number } = {
      method,
      headers,
    };
    if (this.timeoutMs !== undefined) init.timeoutMs = this.timeoutMs;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    try {
      return await this.fetchImpl(url, init);
    } catch (cause) {
      if (cause instanceof ApiError) throw cause; // fetch-layer error (e.g. timeout) already precise
      let detail: unknown = cause;
      if (cause && typeof cause === "object" && "cause" in cause && cause.cause !== undefined) {
        detail = cause.cause;
      }
      throw new ApiError("network", `Network error contacting the Cloud.ru console: ${String(detail)}`);
    }
  }
}

function waitForSubscriber<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  const abortError = () => Object.assign(new Error("Cloud.ru API request cancelled"), { name: "AbortError" });
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(abortError()); };
    signal.addEventListener("abort", onAbort, { once: true });
    request.then(
      (result) => { signal.removeEventListener("abort", onAbort); resolve(result); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
    if (signal.aborted) onAbort();
  });
}

function isNotebookList(value: unknown): value is ConsoleNotebooksResponse {
  if (!value || typeof value !== "object" || !("notebooks" in value)) return false;
  const list = value.notebooks;
  return Array.isArray(list) && list.every((nb) =>
    nb && typeof nb.uid === "string" && typeof nb.name === "string" &&
    typeof nb.status === "string" && typeof nb.region === "string");
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Narrow the docker_images response to the first usable image (name/tag/type/labels), or undefined. */
function firstResumeImage(res: unknown): ResolvedHarborImage | undefined {
  if (!res || typeof res !== "object" || !("data" in res)) return undefined;
  const data = res.data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const img: unknown = data[0];
  if (!img || typeof img !== "object") return undefined;
  const name = "name" in img && typeof img.name === "string" ? img.name : undefined;
  const tag = "tag" in img && typeof img.tag === "string" ? img.tag : undefined;
  const type = "type" in img && typeof img.type === "string" ? img.type : undefined;
  if (name === undefined || tag === undefined || type === undefined) return undefined;
  const labels = "labels" in img ? img.labels : {};
  return { name, tag, type, labels };
}
