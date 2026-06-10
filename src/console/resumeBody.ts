// Build the resume payload for POST /jup_web_app/v3/notebooks/{namespace}/resume_request.
// Pure (no `vscode`/network) → unit-testable. Mirrors env-jupyter-server's useResumeNotebookMutation
// (without the optional datahub image lookup, which is only a fallback).
import type { NotebookHandlerResponse } from "../api/types";

const IMAGE_SOURCE_AR = "artifact_registry";
const IMAGE_SOURCE_HARBOR = "harbor";
const IMAGE_TYPE_DEFAULT = "default";

type ResumeImage =
  | { name: string; tag: string; type: string; labels: unknown; source: string }
  | { name: string; labels: unknown; source: string };

export interface ResumeBody {
  name: string;
  region: string;
  instance_type: string;
  allocation_name: string | null;
  queue_name: string | null;
  image: ResumeImage;
}

/** Split an image ref into name + tag the way the web app does (name = everything before the last `:`). */
export function splitImageRef(image: string): { name: string; tag: string } {
  const parts = image.split(":");
  return { name: parts.slice(0, -1).join(":"), tag: parts[parts.length - 1] ?? "" };
}

export function buildResumeBody(notebook: NotebookHandlerResponse): ResumeBody {
  const image: ResumeImage =
    notebook.imageSource === IMAGE_SOURCE_AR
      ? {
          name: notebook.image || "",
          labels: { "mlspace.notebook.authz": "v3", "mlspace.notebook.healthz": "v3" },
          source: IMAGE_SOURCE_AR,
        }
      : {
          ...splitImageRef(notebook.image || ""),
          type: IMAGE_TYPE_DEFAULT,
          labels: {},
          source: IMAGE_SOURCE_HARBOR,
        };

  return {
    name: notebook.name,
    region: notebook.region,
    instance_type: notebook.instanceType || "",
    allocation_name: notebook.allocationName ?? null,
    queue_name: notebook.allocationQueueName ?? null,
    image,
  };
}
