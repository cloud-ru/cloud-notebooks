// Pure header transforms used by the local shim so the notebook UI can be embedded in a VS Code
// webview iframe. No `vscode`/network imports → unit-testable.
//
// The notebook responses carry `X-Frame-Options: DENY` and `Content-Security-Policy:
// frame-ancestors 'self'`, both of which block framing. We strip exactly those framing controls and
// leave the rest of the CSP intact.

export type MutableHeaders = Record<string, string | string[] | undefined>;

/** Remove only the `frame-ancestors` directive from a CSP value, preserving the others. */
export function removeFrameAncestors(csp: string): string {
  return csp
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive.length > 0 && !/^frame-ancestors\b/i.test(directive))
    .join("; ");
}

/**
 * Mutate response headers so the page can be framed by the VS Code webview:
 * drop `X-Frame-Options` and strip `frame-ancestors` from any CSP header.
 * Header names are matched case-insensitively (Node lowercases them, but be defensive).
 */
export function stripFramingHeaders(headers: MutableHeaders): void {
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (lower === "x-frame-options") {
      delete headers[key];
      continue;
    }
    if (lower === "content-security-policy" || lower === "content-security-policy-report-only") {
      const value = headers[key];
      if (typeof value === "string") {
        const next = removeFrameAncestors(value);
        if (next) headers[key] = next;
        else delete headers[key];
      } else if (Array.isArray(value)) {
        const next = value.map(removeFrameAncestors).filter((v) => v.length > 0);
        if (next.length) headers[key] = next;
        else delete headers[key];
      }
    }
  }
}
/**
 * Rewrite upstream Set-Cookie lines so the browser keeps them when the page is served over plain
 * http://127.0.0.1: drop `Secure` and `Domain=…`, and downgrade `SameSite=None` (which requires
 * Secure) to `Lax`. Path/HttpOnly/Expires are preserved.
 */
export function rewriteSetCookieForLocalhost(setCookie: string[]): string[] {
  return setCookie.map((cookie) =>
    cookie
      .split(";")
      .map((attr) => attr.trim())
      .filter((attr) => attr.length > 0 && !/^secure$/i.test(attr) && !/^domain=/i.test(attr))
      .map((attr) => (/^samesite=none$/i.test(attr) ? "SameSite=Lax" : attr))
      .join("; "),
  );
}
