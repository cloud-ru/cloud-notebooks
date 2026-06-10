import { describe, expect, it } from "vitest";
import {
  removeFrameAncestors,
  rewriteSetCookieForLocalhost,
  stripFramingHeaders,
  type MutableHeaders,
} from "../../src/jupyter/headerRewrite";

describe("removeFrameAncestors", () => {
  it("drops only the frame-ancestors directive", () => {
    const csp = "default-src 'none'; frame-ancestors 'self'; report-uri /r";
    expect(removeFrameAncestors(csp)).toBe("default-src 'none'; report-uri /r");
  });

  it("returns empty when frame-ancestors was the only directive", () => {
    expect(removeFrameAncestors("frame-ancestors 'self'")).toBe("");
  });

  it("leaves a CSP without frame-ancestors unchanged", () => {
    expect(removeFrameAncestors("default-src 'self'")).toBe("default-src 'self'");
  });
});

describe("stripFramingHeaders", () => {
  it("removes X-Frame-Options and CSP frame-ancestors, keeps the rest", () => {
    const headers: MutableHeaders = {
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; frame-ancestors 'self'",
      "content-type": "text/html",
    };
    stripFramingHeaders(headers);
    expect(headers["x-frame-options"]).toBeUndefined();
    expect(headers["content-security-policy"]).toBe("default-src 'none'");
    expect(headers["content-type"]).toBe("text/html");
  });

  it("deletes the CSP header entirely when only frame-ancestors was present", () => {
    const headers: MutableHeaders = { "content-security-policy": "frame-ancestors 'self'" };
    stripFramingHeaders(headers);
    expect("content-security-policy" in headers).toBe(false);
  });

  it("handles array-valued CSP headers", () => {
    const headers: MutableHeaders = {
      "content-security-policy": ["frame-ancestors 'self'", "default-src 'self'"],
    };
    stripFramingHeaders(headers);
    expect(headers["content-security-policy"]).toEqual(["default-src 'self'"]);
  });
});

describe("rewriteSetCookieForLocalhost", () => {
  it("strips Secure and Domain so the cookie persists over http://127.0.0.1", () => {
    const out = rewriteSetCookieForLocalhost([
      "_xsrf=tok; Domain=k2-nb.ai.cloud.ru; Path=/x/; Secure; HttpOnly",
    ]);
    expect(out[0]).toBe("_xsrf=tok; Path=/x/; HttpOnly");
  });

  it("downgrades SameSite=None to Lax", () => {
    const out = rewriteSetCookieForLocalhost(["s=1; SameSite=None; Secure"]);
    expect(out[0]).toBe("s=1; SameSite=Lax");
  });
  it("leaves a plain cookie untouched", () => {
    expect(rewriteSetCookieForLocalhost(["a=b; Path=/"])).toEqual(["a=b; Path=/"]);
  });
});
