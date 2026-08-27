// Maps the console UI API notebook DTO to our view model. Pure (no `vscode`) → unit-testable.
// Field shape mirrors env-jupyter-server's `NotebookResponse` (console.cloud.ru/aicloud/ui).
import type { NotebookBucket, NotebookHandlerResponse, NotebookStatus } from "../api/types";

export interface ConsoleNotebook {
  uid: string;
  name: string;
  status: string;
  url?: string | null;
  image?: string;
  imageDisplayName?: string;
  instanceType?: string | null;
  region: string;
  author?: string;
  description?: string | null;
  is_shared?: boolean;
  access_granted?: boolean;
  portal_ref?: string;
  notebookType?: string | null;
  namespace?: string;
  creationTimestamp?: number | null;
  created_at?: string;
  image_source?: string;
  allocation_name?: string | null;
  queue_name?: string | null;
  access_mode?: string;
  pause_at?: string | null;
  autoshutdown_config?: unknown;
  restart_timestamp?: string | null;
  s3_buckets?: { bucket_name?: string; mount_status?: string; access_rule?: string }[];
}

export interface ConsoleNotebooksResponse {
  notebooks: ConsoleNotebook[];
}

/** Every status the extension understands. A raw value outside this set is normalized to `unknown`
 * (which still has a presentation and safe menu grouping) instead of being cast blindly. */
const KNOWN_STATUSES: Record<NotebookStatus, true> = {
  creating: true,
  for_create: true,
  pulling: true,
  waiting: true,
  resuming: true,
  for_resume: true,
  running: true,
  pausing: true,
  for_pause: true,
  paused: true,
  paused_by_schedule: true,
  paused_by_metrics: true,
  paused_by_timer: true,
  deleting: true,
  for_delete: true,
  deleted: true,
  error: true,
  rejected: true,
  warning: true,
  fixing: true,
  unknown: true,
};

function isKnownStatus(raw: string): raw is NotebookStatus {
  return raw in KNOWN_STATUSES;
}

/** Whitelist a raw console status; anything unrecognized becomes `unknown`. */
export function normalizeStatus(raw: string | undefined): NotebookStatus {
  return raw && isKnownStatus(raw) ? raw : "unknown";
}

function creationTimestamp(n: ConsoleNotebook): number | null {
  if (typeof n.creationTimestamp === "number") return n.creationTimestamp;
  if (n.created_at) return Math.floor(new Date(`${n.created_at}Z`).getTime() / 1000);
  return null;
}

/** An auto-shutdown sub-config counts as enabled when present and not explicitly disabled. */
function isShutdownModeEnabled(sub: unknown): boolean {
  if (!sub || typeof sub !== "object") return false;
  if ("shutdown_enabled" in sub) return sub.shutdown_enabled === true;
  return true;
}

/** RU labels of the enabled auto-shutdown modes from a raw `autoshutdown_config`. */
export function autoshutdownModes(config: unknown): string[] {
  if (!config || typeof config !== "object") return [];
  const modes: string[] = [];
  if ("by_timer" in config && isShutdownModeEnabled(config.by_timer)) modes.push("по времени");
  if ("by_schedule" in config && isShutdownModeEnabled(config.by_schedule)) modes.push("по расписанию");
  if ("by_load" in config && isShutdownModeEnabled(config.by_load)) modes.push("по нагрузке");
  return modes;
}

export function mapConsoleNotebook(
  n: ConsoleNotebook,
  onUnknownStatus?: (raw: string) => void,
): NotebookHandlerResponse {
  const status = normalizeStatus(n.status);
  if (status === "unknown" && n.status) onUnknownStatus?.(n.status);
  const buckets = mapBuckets(n.s3_buckets);
  return {
    uid: n.uid,
    name: n.name,
    status,
    url: n.url ?? null,
    image: n.image ?? "",
    imageDisplayName: n.imageDisplayName ?? n.image ?? "",
    instanceType: n.instanceType ?? null,
    region: n.region,
    author: n.author ?? "",
    description: n.description ?? null,
    is_shared: n.is_shared ?? false,
    accessGranted: n.access_granted ?? true,
    portal_ref: n.portal_ref ?? "",
    notebookType: n.notebookType ?? null,
    creationTimestamp: creationTimestamp(n),
    namespace: n.namespace,
    imageSource: n.image_source,
    allocationName: n.allocation_name ?? null,
    allocationQueueName: n.queue_name ?? null,
    accessMode: n.access_mode ?? null,
    autoshutdownModes: autoshutdownModes(n.autoshutdown_config),
    autoshutdownConfig: n.autoshutdown_config,
    ...(buckets !== undefined ? { s3Buckets: buckets } : {}),
    restartTimestamp: n.restart_timestamp ?? null,
    pause_at: n.pause_at ?? null,
  };
}

/** Mount statuses that mean the bucket is unusable (the console shows an alarm for these). */
const BUCKET_ALARM_STATUSES = new Set(["NOT_MOUNTED", "NOT_MOUNT_ERROR", "MOUNT_ERROR"]);

/** Normalize `s3_buckets` to our model; undefined when the console returned no list at all. */
function mapBuckets(buckets: ConsoleNotebook["s3_buckets"]): NotebookBucket[] | undefined {
  if (!Array.isArray(buckets)) return undefined;
  return buckets.map((b) => ({
    name: b.bucket_name ?? "",
    mountStatus: b.mount_status ?? "",
    ...(b.access_rule !== undefined ? { accessRule: b.access_rule } : {}),
  }));
}

/** True when any mounted bucket is in an alarm mount status (mirrors the console's warning icon). */
export function hasBucketMountProblem(nb: NotebookHandlerResponse): boolean {
  if (!nb.s3Buckets) return false;
  return nb.s3Buckets.some((b) => BUCKET_ALARM_STATUSES.has(b.mountStatus.toUpperCase()));
}
