// Minimal JWT helper. Pure (no `vscode`) → unit-testable. We only need the expiry to know when to
// re-mint the token; signature is verified by the server, not here.

interface JwtPayload {
  exp?: number;
}

/** Absolute expiry of a JWT in epoch ms, or undefined if it can't be parsed. */
export function jwtExpiryMs(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(json) as JwtPayload;
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** True when the token is missing or within `skewMs` of expiring. */
export function isJwtExpired(token: string | undefined, skewMs = 30_000, now: number = Date.now()): boolean {
  if (!token) return true;
  const expiry = jwtExpiryMs(token);
  if (expiry === undefined) return true;
  return now >= expiry - skewMs;
}
