// Maps the console UI API notebook DTO to our view model. Pure (no `vscode`) → unit-testable.
// Field shape mirrors env-jupyter-server's `NotebookResponse` (console.cloud.ru/aicloud/ui).
import type { NotebookHandlerResponse, NotebookStatus } from "../api/types";

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
  portal_ref?: string;
  notebookType?: string | null;
  namespace?: string;
  creationTimestamp?: number | null;
  created_at?: string;
}

export interface ConsoleNotebooksResponse {
  notebooks: ConsoleNotebook[];
}

function creationTimestamp(n: ConsoleNotebook): number | null {
  if (typeof n.creationTimestamp === "number") return n.creationTimestamp;
  if (n.created_at) return Math.floor(new Date(`${n.created_at}Z`).getTime() / 1000);
  return null;
}

export function mapConsoleNotebook(n: ConsoleNotebook): NotebookHandlerResponse {
  return {
    uid: n.uid,
    name: n.name,
    status: n.status as NotebookStatus,
    url: n.url ?? null,
    image: n.image ?? "",
    imageDisplayName: n.imageDisplayName ?? n.image ?? "",
    instanceType: n.instanceType ?? null,
    region: n.region,
    author: n.author ?? "",
    description: n.description ?? null,
    is_shared: n.is_shared ?? false,
    portal_ref: n.portal_ref ?? "",
    notebookType: n.notebookType ?? null,
    creationTimestamp: creationTimestamp(n),
    namespace: n.namespace,
  };
}
