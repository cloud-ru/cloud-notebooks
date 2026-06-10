// Client for the Cloud.ru console UI backend — the same API the web app uses. Workspace selection
// mirrors the console flow: customer → project → workspace. Notebook data lives under
// `<origin>/aicloud/ui`; the customer/project bootstrap lives under `<origin>/u-api/bff-console`.
// Authenticated with an OIDC Bearer (+ x-workspace-id for workspace-scoped calls). No `vscode` import
// → unit-testable with an injected fetch.
import { ApiError, apiErrorFromResponse } from "../api/errors";
import type { NotebookHandlerResponse, WorkspaceContext } from "../api/types";
import { type ConsoleNotebooksResponse, mapConsoleNotebook } from "./notebookMapping";

const NAMESPACE_HEADER = "cp-front-mlspace-env-jupyter-server";

/** A customer (organisation) the signed-in user belongs to. */
export interface ConsoleCustomer {
  id: string;
  name: string;
}

/** A project within a customer (flattened out of the folder tree). */
export interface ConsoleProject {
  id: string;
  name: string;
  /** Owning folder name, for display only. */
  folder?: string;
}

/** A workspace from POST /organisation/v2/workspaces/search. Its `id` is the x-workspace-id header. */
export interface ConsoleWorkspace {
  id: string;
  name: string;
  namespace?: string;
  project_name?: string;
  status?: string;
}

export interface ConsoleApiClientOptions {
  /** Console UI backend base, e.g. https://console.cloud.ru/aicloud/ui */
  baseUrl: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

export class ConsoleApiClient {
  private readonly baseUrl: string;
  /** Scheme + host of the console, e.g. https://console.cloud.ru (for the /u-api/bff-console calls). */
  private readonly origin: string;
  private readonly getToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ConsoleApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.origin = new URL(this.baseUrl).origin;
    this.getToken = opts.getToken;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Customers (organisations) the signed-in user belongs to. Bootstrap call — no x-workspace-id. */
  async listCustomers(): Promise<ConsoleCustomer[]> {
    const res = await this.send<{ customers?: Array<{ id: string; name?: string; full_name?: string }> }>(
      "GET",
      `${this.origin}/u-api/bff-console/v2/customers/me`,
      {},
    );
    return (res.customers ?? []).map((c) => ({ id: c.id, name: c.name ?? c.full_name ?? c.id }));
  }

  /** Projects within a customer, flattened out of the folder tree. */
  async listProjects(customerId: string): Promise<ConsoleProject[]> {
    const res = await this.send<{
      folders?: Array<{ name?: string; projects?: Array<{ id: string; name: string }> }>;
    }>(
      "GET",
      `${this.origin}/u-api/bff-console/v1/simple-projects?customerId=${encodeURIComponent(customerId)}`,
      {},
    );
    const projects: ConsoleProject[] = [];
    for (const folder of res.folders ?? []) {
      for (const project of folder.projects ?? []) {
        projects.push({ id: project.id, name: project.name, ...(folder.name ? { folder: folder.name } : {}) });
      }
    }
    return projects;
  }

  /** Active workspaces in a project (the console "workspace switcher" list, scoped by project). */
  async searchWorkspaces(customerId: string, projectId: string): Promise<ConsoleWorkspace[]> {
    const res = await this.send<{ workspaces?: ConsoleWorkspace[] }>(
      "POST",
      `${this.baseUrl}/organisation/v2/workspaces/search`,
      {
        body: {
          customer_id: customerId,
          project_id: projectId,
          page: 1,
          page_size: 200,
          query: "",
          sort_desc: true,
          status: "active",
        },
      },
    );
    return res.workspaces ?? [];
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
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
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
