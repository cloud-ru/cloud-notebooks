// Typed client for the Cloud.ru ML Space public API. No `vscode` import: it takes a `getToken`
// callback and an injectable `fetchImpl`, which keeps it unit-testable with a stubbed fetch.
import { ApiError, apiErrorFromResponse } from "./errors";
import type {
  APIKeyResponse,
  BaseToken,
  ListNotebooksQuery,
  ListNotebooksResponseV2,
  ListWorkspacesResponse,
  NotebookHandlerResponse,
  ServiceAccount,
  ServiceAuthResponse,
  Workspace,
  WorkspaceContext,
} from "./types";

type AuthMode = "none" | "bearer" | "workspace";

/** IAM access-key → token exchange; works for both personal and service-account access keys. */
const DEFAULT_IAM_TOKEN_URL = "https://id.cloud.ru/auth/system/openid/token";

export interface MlSpaceClientOptions {
  /** API root, e.g. https://api.ai.cloud.ru (no trailing slash, no /public/v2). */
  baseUrl: string;
  /** Returns a currently-valid Bearer access token. */
  getToken: () => Promise<string>;
  /** IAM token endpoint used as a fallback exchange. Defaults to id.cloud.ru. */
  iamTokenUrl?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  method?: "GET" | "POST";
  auth: AuthMode;
  ws?: WorkspaceContext;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
}

export class MlSpaceApiClient {
  private readonly baseUrl: string;
  private readonly iamTokenUrl: string;
  private readonly getToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MlSpaceClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.iamTokenUrl = opts.iamTokenUrl ?? DEFAULT_IAM_TOKEN_URL;
    this.getToken = opts.getToken;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Exchange an access key for a Bearer token. Tries ML Space `service_auth` first (its token is the
   * one the ML Space API documents), and on a 401 falls back to the IAM `access_key` grant, which
   * accepts both personal and service-account access keys.
   */
  async authenticate(creds: ServiceAccount): Promise<{ token: BaseToken; via: "service_auth" | "iam" }> {
    try {
      return { token: await this.authServiceAccount(creds), via: "service_auth" };
    } catch (err) {
      if (err instanceof ApiError && err.kind === "auth") {
        return { token: await this.authViaIam(creds), via: "iam" };
      }
      throw err;
    }
  }

  /** Exchange service-account credentials via ML Space service_auth. */
  async authServiceAccount(creds: ServiceAccount): Promise<BaseToken> {
    const res = await this.request<ServiceAuthResponse>("/public/v2/service_auth", {
      method: "POST",
      auth: "none",
      body: creds,
    });
    return res.token;
  }

  /** Exchange an access key via the Cloud.ru IAM OpenID endpoint (grant_type=access_key). */
  private async authViaIam(creds: ServiceAccount): Promise<BaseToken> {
    const body = new URLSearchParams({
      grant_type: "access_key",
      client_id: creds.client_id,
      client_secret: creds.client_secret,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(this.iamTokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body.toString(),
      });
    } catch (cause) {
      throw new ApiError("network", `Network error contacting IAM: ${String(cause)}`);
    }

    const raw = await response.text();
    const parsed = raw ? safeJsonParse(raw) : undefined;
    if (!response.ok) {
      throw apiErrorFromResponse(response.status, parsed ?? raw, response.headers.get("retry-after"));
    }

    const data = (parsed ?? {}) as { access_token?: string; token_type?: string; expires_in?: number };
    if (!data.access_token) {
      throw new ApiError("auth", "IAM did not return an access_token.");
    }
    return {
      access_token: data.access_token,
      token_type: data.token_type ?? "Bearer",
      expires_in: data.expires_in ?? 3600,
    };
  }

  /** Per-workspace X-API-KEY. Requires the x-workspace-id header to know which workspace's key. */
  async getXApiKey(workspaceId: string): Promise<string> {
    const res = await this.request<APIKeyResponse>("/public/v2/workspaces/v1/x_api_key", {
      auth: "bearer",
      headers: { "x-workspace-id": workspaceId },
    });
    return res["x-api-key"];
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const res = await this.request<ListWorkspacesResponse>("/public/v2/workspaces/v3/", {
      auth: "bearer",
    });
    return res.workspaces;
  }

  async listNotebooks(
    ws: WorkspaceContext,
    query: ListNotebooksQuery = {},
  ): Promise<NotebookHandlerResponse[]> {
    const res = await this.request<ListNotebooksResponseV2>("/public/v2/notebooks/v2/notebooks", {
      auth: "workspace",
      ws,
      query: {
        notebook_type: query.notebook_type,
        order_by: query.order_by ?? "creationTimestamp",
        desc: query.desc ?? true,
        limit: query.limit,
        offset: query.offset,
        search: query.search,
        status: query.status,
        access_mode: query.access_mode,
      },
    });
    return res.notebooks;
  }

  private async request<T>(path: string, opts: RequestOptions): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.auth !== "none") {
      headers.Authorization = `Bearer ${await this.getToken()}`;
    }
    if (opts.auth === "workspace") {
      if (!opts.ws) throw new ApiError("unknown", "Workspace context is required for this request.");
      headers["x-api-key"] = opts.ws.xApiKey;
      headers["x-workspace-id"] = opts.ws.workspaceId;
    }
    if (opts.headers) Object.assign(headers, opts.headers);

    const init: RequestInit = { method: opts.method ?? "GET", headers };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), init);
    } catch (cause) {
      throw new ApiError("network", `Network error contacting ${url.host}: ${String(cause)}`);
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
