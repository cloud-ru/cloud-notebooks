// Client for the Cloud.ru console UI backend (console.cloud.ru/aicloud/ui) — the same API the web app
// uses. Authenticated with an OIDC Bearer + x-workspace-id (+ front-initiator-namespace). No vscode →
// unit-testable with an injected fetch.
import { ApiError, apiErrorFromResponse } from "../api/errors";
import type { NotebookHandlerResponse, WorkspaceContext } from "../api/types";
import { type ConsoleNotebooksResponse, mapConsoleNotebook } from "./notebookMapping";

const NAMESPACE_HEADER = "cp-front-mlspace-env-jupyter-server";

/** Workspace list item from GET /user/v1/workspaces/ (console "switcher" list). */
export interface ConsoleWorkspace {
  workspace_id: string;
  workspace_name: string;
  namespace?: string;
  project_name?: string;
  email?: string;
  workspace_status?: string;
}

export interface ConsoleApiClientOptions {
  /** Console UI backend base, e.g. https://console.cloud.ru/aicloud/ui */
  baseUrl: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

export class ConsoleApiClient {
  private readonly baseUrl: string;
  private readonly getToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ConsoleApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.getToken = opts.getToken;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Workspaces the signed-in user can access (no x-workspace-id — this is the bootstrap call). */
  async listWorkspaces(): Promise<ConsoleWorkspace[]> {
    const res = await this.request<ConsoleWorkspace[]>("GET", "/user/v1/workspaces/", undefined);
    return Array.isArray(res) ? res : [];
  }

  async listNotebooks(ws: WorkspaceContext): Promise<NotebookHandlerResponse[]> {
    const res = await this.request<ConsoleNotebooksResponse>(
      "GET",
      "/notebooks/v2/?include_private=true",
      ws.workspaceId,
    );
    return (res.notebooks ?? []).map(mapConsoleNotebook);
  }

  async pauseNotebook(ws: WorkspaceContext, uid: string): Promise<void> {
    await this.request<unknown>("POST", `/notebooks/v4/${uid}/pause`, ws.workspaceId);
  }

  async resumeNotebook(ws: WorkspaceContext, namespace: string, body: unknown): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/jup_web_app/v3/notebooks/${namespace}/resume_request`,
      ws.workspaceId,
      body,
    );
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    workspaceId: string | undefined,
    body?: unknown,
  ): Promise<T> {
    const token = await this.getToken();
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "front-initiator-namespace": NAMESPACE_HEADER,
    };
    if (workspaceId) headers["x-workspace-id"] = workspaceId;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, init);
    } catch (cause) {
      throw new ApiError("network", `Network error contacting the Cloud.ru console: ${String(cause)}`);
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
