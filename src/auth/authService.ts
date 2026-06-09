import * as vscode from "vscode";
import { ApiError } from "../api/errors";
import type { BaseToken, ServiceAccount } from "../api/types";
import type { Logger } from "../util/logger";
import { parseAccessKey } from "./credentialInput";
import { TokenCache } from "./tokenCache";

const CREDENTIALS_SECRET_KEY = "cloudru.credentials";

interface StoredCredentials {
  clientId: string;
  clientSecret: string;
}

export interface AuthServiceDeps {
  secrets: vscode.SecretStorage;
  logger: Logger;
  /** Exchanges credentials for a token (wired to MlSpaceApiClient.authenticate). */
  exchange: (creds: ServiceAccount) => Promise<{ token: BaseToken; via: "service_auth" | "iam" }>;
}

/**
 * Service-account authentication: stores the Access Key in SecretStorage and exchanges it for a
 * short-lived Bearer token on demand. There is no refresh token in the `access_key` grant, so
 * "refresh" means re-running the exchange with the stored key.
 */
export class AuthService {
  private readonly cache = new TokenCache();
  private readonly onDidChange = new vscode.EventEmitter<boolean>();
  /** Fires with the new authenticated state whenever sign-in/sign-out happens. */
  readonly onDidChangeAuth = this.onDidChange.event;

  constructor(private readonly deps: AuthServiceDeps) {}

  async isSignedIn(): Promise<boolean> {
    return (await this.loadCredentials()) !== undefined;
  }

  /** Interactive sign-in. Returns true on success, false if the user cancelled. */
  async signIn(): Promise<boolean> {
    const creds = await this.promptForCredentials();
    if (!creds) return false;

    // Validate the credentials by performing the exchange before persisting them.
    await this.exchangeAndCache(creds);
    await this.deps.secrets.store(CREDENTIALS_SECRET_KEY, JSON.stringify(creds));
    this.deps.logger.info(`Signed in as service account ${creds.clientId}.`);
    this.onDidChange.fire(true);
    return true;
  }

  /**
   * Single-paste sign-in: the user pastes the whole access key ("KEY_ID:KEY_SECRET" or the JSON the
   * console hands out). Falls back to two separate fields when the value cannot be parsed.
   */
  private async promptForCredentials(): Promise<StoredCredentials | undefined> {
    const pasted = await vscode.window.showInputBox({
      title: "Cloud.ru sign in",
      prompt: "Paste your service account access key — “Key ID:Key Secret” or the JSON from the console",
      password: true,
      ignoreFocusOut: true,
    });
    if (pasted === undefined) return undefined; // user cancelled

    const parsed = parseAccessKey(pasted);
    if (parsed) return parsed;
    if (pasted.trim()) {
      void vscode.window.showWarningMessage(
        "Couldn’t read that as a key. Enter the Key ID and Key Secret separately.",
      );
    }

    const clientId = await vscode.window.showInputBox({
      title: "Cloud.ru sign in (1/2)",
      prompt: "Service account Access Key ID (client_id)",
      ignoreFocusOut: true,
    });
    if (!clientId) return undefined;

    const clientSecret = await vscode.window.showInputBox({
      title: "Cloud.ru sign in (2/2)",
      prompt: "Service account Access Key Secret (client_secret)",
      password: true,
      ignoreFocusOut: true,
    });
    if (!clientSecret) return undefined;

    return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
  }

  async signOut(): Promise<void> {
    this.cache.clear();
    await this.deps.secrets.delete(CREDENTIALS_SECRET_KEY);
    this.deps.logger.info("Signed out.");
    this.onDidChange.fire(false);
  }

  /** Returns a valid Bearer token, transparently re-authenticating with the stored key. */
  async getAccessToken(): Promise<string> {
    const cached = this.cache.get();
    if (cached) return cached;

    const creds = await this.loadCredentials();
    if (!creds) {
      throw new ApiError("auth", "Not signed in to Cloud.ru. Run “Cloud.ru: Sign In” first.");
    }
    return this.exchangeAndCache(creds);
  }

  private async exchangeAndCache(creds: StoredCredentials): Promise<string> {
    const { token, via } = await this.deps.exchange({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    });
    this.cache.set(token.access_token, token.expires_in);
    this.deps.logger.info(`Access token obtained via ${via}.`);
    return token.access_token;
  }

  private async loadCredentials(): Promise<StoredCredentials | undefined> {
    const raw = await this.deps.secrets.get(CREDENTIALS_SECRET_KEY);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as StoredCredentials;
      if (parsed.clientId && parsed.clientSecret) return parsed;
    } catch {
      // Corrupt entry — treat as signed out.
    }
    return undefined;
  }

  dispose(): void {
    this.onDidChange.dispose();
  }
}
