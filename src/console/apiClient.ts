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

export interface ConsoleApiClientOptions {
  /** Console UI backend base, e.g. https://console.cloud.ru/aicloud/ui */
  baseUrl: string;
  getToken: () => Promise<string>;
  /** Injected for tests; defaults to the system-CA-trusting https client. */
  fetchImpl?: HttpFetch;
}

export class ConsoleApiClient {
  private readonly baseUrl: string;
  private readonly getToken: () => Promise<string>;
  private readonly fetchImpl: HttpFetch;

  constructor(opts: ConsoleApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.getToken = opts.getToken;
    this.fetchImpl = opts.fetchImpl ?? consoleFetch;
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

  private async send<T>(
    method: "GET" | "POST",
    url: string,
    opts: { workspaceId?: string; body?: unknown },
  ): Promise<T> {
    const token = await this.getToken();
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

    let response: HttpResponse;
    try {
      response = await this.fetchImpl(url, init);
    } catch (cause) {
      const detail = (cause as { cause?: unknown })?.cause ?? cause;
      throw new ApiError("network", `Network error contacting the Cloud.ru console: ${String(detail)}`);
    }

    const raw = await response.text();
    const parsed = raw ? safeJsonParse(raw) : undefined;
    if (!response.ok) {
      throw apiErrorFromResponse(response.status, parsed ?? raw, response.headers.get("retry-after"));
    }
    return parsed as T;
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
