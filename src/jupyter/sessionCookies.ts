import * as vscode from "vscode";

/**
 * Stores the captured `authservice_session` cookie per notebook host in SecretStorage. It is the only
 * credential that authenticates the notebook OIDC proxy, so it must be treated as a secret.
 */
export class NotebookSessionStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async get(host: string): Promise<string | undefined> {
    return this.secrets.get(key(host));
  }

  /** `cookie` is the full pair, e.g. `authservice_session=...`. */
  async set(host: string, cookie: string): Promise<void> {
    await this.secrets.store(key(host), cookie);
  }

  async clear(host: string): Promise<void> {
    await this.secrets.delete(key(host));
  }
}

function key(host: string): string {
  return `cloudru.notebookSession.${host}`;
}
