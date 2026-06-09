import * as vscode from "vscode";
import type { WorkspaceContext } from "../api/types";

const WORKSPACE_SECRET_KEY = "cloudru.workspace";

/**
 * Holds the active workspace context (workspace id, namespace, x-api-key). Persisted in
 * SecretStorage because the x-api-key is sensitive.
 */
export class SessionStore {
  private current: WorkspaceContext | undefined;
  private readonly onDidChange = new vscode.EventEmitter<WorkspaceContext | undefined>();
  readonly onDidChangeWorkspace = this.onDidChange.event;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** Restore a previously selected workspace, if any. Call once on activation. */
  async restore(): Promise<void> {
    const raw = await this.secrets.get(WORKSPACE_SECRET_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as WorkspaceContext;
      if (parsed.workspaceId && parsed.xApiKey) this.current = parsed;
    } catch {
      // ignore corrupt entry
    }
  }

  get(): WorkspaceContext | undefined {
    return this.current;
  }

  async set(ctx: WorkspaceContext): Promise<void> {
    this.current = ctx;
    await this.secrets.store(WORKSPACE_SECRET_KEY, JSON.stringify(ctx));
    this.onDidChange.fire(ctx);
  }

  async clear(): Promise<void> {
    this.current = undefined;
    await this.secrets.delete(WORKSPACE_SECRET_KEY);
    this.onDidChange.fire(undefined);
  }

  dispose(): void {
    this.onDidChange.dispose();
  }
}
