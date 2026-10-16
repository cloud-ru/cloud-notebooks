// Minimal JWT helper. Pure (no `vscode`) → unit-testable. We only need the expiry to know when to
// re-mint the token and the account it belongs to; signature is verified by the server, not here.
import { createHash } from "node:crypto";

interface JwtPayload {
  exp?: unknown;
  iss?: unknown;
  sub?: unknown;
}

function jwtPayload(token: string): JwtPayload | undefined {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload: unknown = JSON.parse(json);
    return payload && typeof payload === "object" ? (payload as JwtPayload) : undefined;
  } catch {
    return undefined;
  }
}

/** Absolute expiry of a JWT in epoch ms, or undefined if it can't be parsed. */
export function jwtExpiryMs(token: string): number | undefined {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

/** Fingerprint of the account a token was issued to (issuer + subject), hashed so the user id isn't
 * kept in the clear. Undefined when the token has no `sub`. */
export function jwtAccountFingerprint(token: string): string | undefined {
  const payload = jwtPayload(token);
  if (typeof payload?.sub !== "string" || !payload.sub) return undefined;
  const issuer = typeof payload.iss === "string" ? payload.iss : "";
  return createHash("sha256").update(`${issuer}\n${payload.sub}`).digest("hex");
}

/** Default margin before `exp` at which a token is already treated as expired. */
export const JWT_EXPIRY_SKEW_MS = 30_000;

/** True when the token is missing or within `skewMs` of expiring. */
export function isJwtExpired(token: string | undefined, skewMs = JWT_EXPIRY_SKEW_MS, now: number = Date.now()): boolean {
  if (!token) return true;
  const expiry = jwtExpiryMs(token);
  if (expiry === undefined) return true;
  return now >= expiry - skewMs;
}
