import * as vscode from "vscode";
import type { WorkspaceContext } from "../api/types";

const WORKSPACE_SECRET_KEY = "cloudru.workspace";

/**
 * Holds the active workspace selection (`x-workspace-id` + display name). Persisted in SecretStorage
 * so it survives restarts.
 */
export class SessionStore {
  private current: WorkspaceContext | undefined;
  private generation = 0;
  private readonly onDidChange = new vscode.EventEmitter<WorkspaceContext | undefined>();
  readonly onDidChangeWorkspace = this.onDidChange.event;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** Restore a previously selected workspace, if any. Call once on activation. */
  async restore(): Promise<void> {
    const raw = await this.secrets.get(WORKSPACE_SECRET_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as WorkspaceContext;
      if (parsed.workspaceId) this.current = parsed;
    } catch {
      // ignore corrupt entry
    }
  }

  get(): WorkspaceContext | undefined {
    return this.current;
  }

  /** Identifies the current auth/workspace context, including a re-login to the same workspace. */
  getGeneration(): number {
    return this.generation;
  }

  invalidateAuthContext(): void {
    this.generation++;
    this.onDidChange.fire(this.current);
  }

  async set(ctx: WorkspaceContext): Promise<void> {
    this.current = ctx;
    this.generation++;
    this.onDidChange.fire(ctx);
    await this.secrets.store(WORKSPACE_SECRET_KEY, JSON.stringify(ctx));
  }

  async clear(): Promise<void> {
    this.current = undefined;
    this.generation++;
    this.onDidChange.fire(undefined);
    await this.secrets.delete(WORKSPACE_SECRET_KEY);
  }

  dispose(): void {
    this.onDidChange.dispose();
  }
}
