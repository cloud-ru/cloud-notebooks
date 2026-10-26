// Pure request checks for the local Jupyter proxy (`NotebookShim`). No `vscode`/network imports →
// unit-testable.
//
// The shim fronts the pod's tokenless JupyterLab on 127.0.0.1, so these helpers decide who may use it:
// the Host/Origin/Sec-Fetch checks keep web pages (including DNS-rebinding ones) out, and the shim's
// 256-bit secret identifies its two clients — the notebook webview (a cookie, bootstrapped once from the
// iframe `src`) and the Jupyter extension (a Jupyter `token`).

import { timingSafeEqual } from "node:crypto";

/** Query parameter that carries the secret in the webview iframe `src`; the shim trades it for a cookie. */
export const BOOTSTRAP_PARAM = "cloudru_shim";
/** Jupyter-style credential parameter (`?token=`), used by the Jupyter extension for WebSockets. */
export const TOKEN_PARAM = "token";

const COOKIE_PREFIX = "cloudru_shim_";
/** URL-safe base64 without padding — exactly what `Buffer#toString("base64url")` produces. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Shim credentials found in a request target, and the target without them. */
export interface Credentials {
  bootstrap?: string;
  token?: string;
  cleanUrl: string;
}

/** Cookies ignore ports, so each shim needs its own cookie name: `cloudru_shim_<port>`. */
export function cookieName(port: number): string {
  return `${COOKIE_PREFIX}${port}`;
}

/**
 * The Host header must name the shim itself. Any other name means a DNS-rebinding page whose hostname
 * resolves to 127.0.0.1 — the browser would treat its requests as same-origin.
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  const value = host?.toLowerCase();
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`;
}

/**
 * Browsers send Origin on cross-origin fetches, non-GET requests and every WebSocket handshake, so any
 * foreign value — other sites, other webviews, the opaque "null" of sandboxed frames — is refused. A
 * missing Origin comes from non-browser clients (Jupyter extension, probes) or browser GETs and
 * navigations, which the Sec-Fetch check and the credential cover.
 */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  const value = origin.toLowerCase();
  return value === `http://127.0.0.1:${port}` || value === `http://localhost:${port}`;
}

/**
 * Cross-site browser requests may only be navigations: the webview frames the shim cross-site, but no
 * other page may get its fetches, subresources or WebSockets — which would carry the shim cookie —
 * through. Absent headers mean a non-browser client.
 */
export function isAllowedFetchSite(headers: {
  "sec-fetch-site"?: string | undefined;
  "sec-fetch-mode"?: string | undefined;
}): boolean {
  const site = headers["sec-fetch-site"];
  if (site === undefined || site === "same-origin" || site === "none") return true;
  return headers["sec-fetch-mode"] === "navigate";
}

/** The credential of an `Authorization: token <secret>` header (scheme case-insensitive). */
export function authorizationToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const value = header.trim();
  const scheme = /^token\s+/i.exec(value);
  return scheme ? value.slice(scheme[0].length) : undefined;
}

/** Value of the cookie `name` in a Cookie header. */
export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  for (const pair of cookieHeader?.split(";") ?? []) {
    const eq = pair.indexOf("=");
    if (eq !== -1 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return undefined;
}

/** Whether a cookie pair or Set-Cookie line names a shim credential cookie, whatever its port. */
export function isShimCookie(cookie: string): boolean {
  const pair = cookie.split(";", 1)[0];
  const eq = pair.indexOf("=");
  return eq !== -1 && pair.slice(0, eq).trim().startsWith(COOKIE_PREFIX);
}

/**
 * Drop every shim credential cookie from a Cookie header — not only the receiving shim's: all shims
 * share the 127.0.0.1 cookie jar, so one notebook's frame also sends the other notebooks' secrets.
 * `undefined` when nothing is left.
 */
export function withoutShimCookies(cookieHeader: string | undefined): string | undefined {
  const kept = (cookieHeader?.split(";") ?? [])
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0 && !isShimCookie(pair));
  return kept.length ? kept.join("; ") : undefined;
}

/**
 * Take the `cloudru_shim` and `token` parameters out of a request target (path + query). The other
 * parameters keep their order, and `/lab` stays `/lab`; a target without credentials is returned
 * untouched. Once something was removed, the target is rebuilt as a plain path — never protocol-relative
 * (`//host`), since the bootstrap redirect uses it as `Location`. Throws on a target the URL parser
 * rejects; no legitimate client sends one.
 */
export function splitCredentials(url: string): Credentials {
  const parsed = new URL(url, "http://x");
  const bootstrap = parsed.searchParams.get(BOOTSTRAP_PARAM);
  const token = parsed.searchParams.get(TOKEN_PARAM);
  if (bootstrap === null && token === null) return { cleanUrl: url };
  parsed.searchParams.delete(BOOTSTRAP_PARAM);
  parsed.searchParams.delete(TOKEN_PARAM);
  const credentials: Credentials = { cleanUrl: parsed.pathname.replace(/^\/+/, "/") + parsed.search };
  if (bootstrap !== null) credentials.bootstrap = bootstrap;
  if (token !== null) credentials.token = token;
  return credentials;
}

/**
 * Constant-time check of a base64url candidate against the secret. Node's decoder silently skips
 * foreign characters, so the alphabet is validated first; an empty secret matches nothing.
 */
export function tokenMatches(candidate: string | undefined, secret: Buffer): boolean {
  if (!candidate || secret.length === 0 || !BASE64URL.test(candidate)) return false;
  const decoded = Buffer.from(candidate, "base64url");
  return decoded.length === secret.length && timingSafeEqual(decoded, secret);
}
