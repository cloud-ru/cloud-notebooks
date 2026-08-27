// View models the extension binds to. The notebook shape is normalized from the Cloud.ru console UI
// API (console.cloud.ru/aicloud/ui) by `src/console/notebookMapping.ts`.

export type NotebookStatus =
  | "creating"
  | "for_create"
  | "pulling"
  | "waiting"
  | "resuming"
  | "for_resume"
  | "running"
  | "pausing"
  | "for_pause"
  | "paused"
  | "paused_by_schedule"
  | "paused_by_metrics"
  | "paused_by_timer"
  | "deleting"
  | "for_delete"
  | "deleted"
  | "error"
  | "rejected"
  | "warning"
  | "fixing"
  // Synthetic: a status the console returned that we do not recognize (normalizeStatus fallback).
  | "unknown";

/** A bucket mounted into the notebook, from the console DTO's `s3_buckets`. */
export interface NotebookBucket {
  name: string;
  /** Raw console `mount_status`: "NOT_MOUNTED" | "MOUNTED" | "NOT_MOUNT_ERROR" | "MOUNT_ERROR". */
  mountStatus: string;
  /** Raw console `access_rule` (e.g. "ro" / "rw"). */
  accessRule?: string;
}

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
  /** False when this is another user's private notebook the caller may not access. */
  accessGranted?: boolean;
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
  /** Access mode: "private" | "shared" | "multiuser". */
  accessMode?: string | null;
  /** Enabled auto-shutdown modes, as RU labels (e.g. "по времени"). Empty = auto-shutdown off. */
  autoshutdownModes?: string[];
  /**
   * Raw `autoshutdown_config` DTO as returned by the console (by_timer/by_schedule/by_load), echoed
   * back verbatim by the modify endpoint. Undefined when the notebook has no such config.
   */
  autoshutdownConfig?: unknown;
  /** Buckets mounted into the notebook; undefined when the console returned no list at all. */
  s3Buckets?: NotebookBucket[];
  /** When present, the pod hit a node problem and will be restarted automatically at this time. */
  restartTimestamp?: string | null;
}

/** The active workspace selection (`x-workspace-id`). */
export interface WorkspaceContext {
  workspaceId: string;
  workspaceName: string;
  /** Kubernetes namespace of the workspace (from /user/v1/workspaces/). Authoritative source for
   * the resume endpoint, which is keyed by namespace. */
  namespace?: string;
}

/** Notebook logs response (GET /notebooks/v2/{ns}/{name}/logs). */
export interface NotebookLogs {
  logs: string;
  notebook_status: string;
  status_reason: string;
}

/** Project preflight (GET /notebooks/v2/preflight): whether the project can run/connect notebooks. */
export interface ProjectStatus {
  access: boolean;
  rejection?: string;
}

/** Distributed Train SSH key pair (GET/POST /user/v1/user_ssh_keys/*). */
export interface SshKeyPair {
  public_key: string;
  private_key: string;
}
