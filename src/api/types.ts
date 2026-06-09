// Curated subset of the Cloud.ru ML Space public API (v2.7.0) used by this extension.
// Source of truth: docs/reference/mlspace-public-api.openapi.json + docs/api-contract.md.
// Hand-written on purpose for the auth slice; the full DTO set can later be generated
// with `openapi-typescript` (see docs/decisions.md D2).

/** Service-account credentials (Access Key). Request body of POST /public/v2/service_auth. */
export interface ServiceAccount {
  client_id: string;
  client_secret: string;
}

/** Token object returned by service_auth. */
export interface BaseToken {
  access_token: string;
  token_type?: string;
  /** Lifetime in seconds. */
  expires_in: number;
}

export interface ServiceAuthResponse {
  token: BaseToken;
}

export interface APIKeyResponse {
  "x-api-key": string;
}

export interface WorkspaceAllocation {
  id: string;
  name: string;
  cluster_key: string;
  cluster_name: string | null;
}

export interface Workspace {
  /** Workspace UUID — used as the `x-workspace-id` header. */
  id: string;
  name: string;
  /** Kubernetes namespace — required for v1 notebook resume/pause. */
  namespace: string;
  project_id: string;
  project_name: string;
  owner_email: string;
  allocations: WorkspaceAllocation[];
}

export interface ListWorkspacesResponse {
  workspaces: Workspace[];
}

export type NotebookStatus =
  | "creating"
  | "paused"
  | "paused_by_schedule"
  | "paused_by_metrics"
  | "paused_by_timer"
  | "pausing"
  | "error"
  | "resuming"
  | "deleting"
  | "waiting"
  | "running"
  | "warning"
  | "fixing";

/** Notebook list item from GET /public/v2/notebooks/v2/notebooks. */
export interface NotebookHandlerResponse {
  uid: string;
  name: string;
  status: NotebookStatus;
  /** Jupyter URL (the link opened in the browser today). Present for running notebooks. */
  url?: string | null;
  image: string;
  imageDisplayName: string;
  instanceType?: string | null;
  region: string;
  author: string;
  description?: string | null;
  is_shared: boolean;
  portal_ref: string;
  notebookType?: string | null;
  pause_at?: string | null;
  creationTimestamp?: number | null;
  updated_at?: string | null;
  /** Kubernetes namespace (present from the console API; used for resume). */
  namespace?: string | undefined;
}

export interface ListNotebooksResponseV2 {
  notebooks: NotebookHandlerResponse[];
}

/** Query params for the v2 notebooks listing. */
export interface ListNotebooksQuery {
  notebook_type?: "Spark" | "Default";
  order_by?: "name" | "creationTimestamp";
  desc?: boolean;
  limit?: number;
  offset?: number;
  search?: string;
  /** Comma-separated statuses, e.g. "creating,running". */
  status?: string;
  /** Comma-separated access modes, e.g. "private,shared,multiuser". */
  access_mode?: string;
}

/** Everything needed to make authenticated data calls for one workspace. */
export interface WorkspaceContext {
  workspaceId: string;
  xApiKey: string;
  namespace: string;
  workspaceName: string;
}
