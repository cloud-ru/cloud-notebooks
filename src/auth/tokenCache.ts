// In-memory access-token cache with expiry + clock skew handling. Pure (no `vscode`), unit-testable.

export interface CachedToken {
  accessToken: string;
  /** Absolute expiry in epoch ms. */
  expiresAtMs: number;
}

export class TokenCache {
  private token: CachedToken | undefined;

  /** Refresh this many ms before the real expiry to avoid using a token mid-flight. */
  constructor(private readonly skewMs = 60_000) {}

  /** Store a token given its lifetime in seconds (the API's `expires_in`). */
  set(accessToken: string, expiresInSeconds: number, now: number = Date.now()): void {
    this.token = { accessToken, expiresAtMs: now + expiresInSeconds * 1000 };
  }

  /** Returns the token only while it is still valid (accounting for skew); otherwise undefined. */
  get(now: number = Date.now()): string | undefined {
    if (!this.token) return undefined;
    if (now >= this.token.expiresAtMs - this.skewMs) return undefined;
    return this.token.accessToken;
  }

  clear(): void {
    this.token = undefined;
  }
}
