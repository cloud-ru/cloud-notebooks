// Client for the Cloud.ru console UI backend (console.cloud.ru/aicloud/ui) — the same API the web app
// uses. Authenticated with an OIDC Bearer + x-workspace-id (+ front-initiator-namespace). No vscode →
// unit-testable with an injected fetch.
import { ApiError, apiErrorFromResponse } from "../api/errors";
import type { NotebookHandlerResponse, WorkspaceContext } from "../api/types";
import { type ConsoleNotebooksResponse, mapConsoleNotebook } from "./notebookMapping";

const NAMESPACE_HEADER = "cp-front-mlspace-env-jupyter-server";

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

  async listNotebooks(ws: WorkspaceContext): Promise<NotebookHandlerResponse[]> {
    const res = await this.request<ConsoleNotebooksResponse>(
      "/notebooks/v2/?include_private=true",
      ws.workspaceId,
    );
    return (res.notebooks ?? []).map(mapConsoleNotebook);
  }

  private async request<T>(path: string, workspaceId: string): Promise<T> {
    const token = await this.getToken();
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "x-workspace-id": workspaceId,
      "front-initiator-namespace": NAMESPACE_HEADER,
    };

    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, { headers });
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
