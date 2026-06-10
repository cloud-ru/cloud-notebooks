// View models the extension binds to. The notebook shape is normalized from the Cloud.ru console UI
// API (console.cloud.ru/aicloud/ui) by `src/console/notebookMapping.ts`.

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

/** Normalized notebook list item used by the tree, SSH, and kernel features. */
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
  /** Kubernetes namespace (from the console API; used for resume). */
  namespace?: string | undefined;
  /** Image source: "harbor" | "artifact_registry" — needed to build the resume body. */
  imageSource?: string | undefined;
  allocationName?: string | null;
  allocationQueueName?: string | null;
}

/** The active workspace selection (`x-workspace-id`). */
export interface WorkspaceContext {
  workspaceId: string;
  workspaceName: string;
}
