import { describe, expect, it } from "vitest";
import {
  authorizationToken,
  cookieName,
  isAllowedFetchSite,
  isAllowedHost,
  isAllowedOrigin,
  isShimCookie,
  readCookie,
  splitCredentials,
  tokenMatches,
  withoutShimCookies,
  type Credentials,
} from "../../src/jupyter/shimAuth";

const PORT = 8899;

describe("cookieName", () => {
  it("gives every shim port its own cookie", () => {
    expect(cookieName(PORT)).toBe("cloudru_shim_8899");
    expect(cookieName(8900)).not.toBe(cookieName(PORT));
  });
});

describe("isAllowedHost", () => {
  it.each<[string | undefined, boolean]>([
    ["127.0.0.1:8899", true],
    ["localhost:8899", true],
    ["LOCALHOST:8899", true],
    ["127.0.0.1:8898", false],
    ["localhost:88990", false],
    ["127.0.0.1", false],
    ["evil.test:8899", false],
    ["127.0.0.1.nip.io:8899", false],
    ["[::1]:8899", false],
    ["", false],
    [undefined, false],
  ])("Host %j → %s", (host, allowed) => {
    expect(isAllowedHost(host, PORT)).toBe(allowed);
  });
});

describe("isAllowedOrigin", () => {
  it.each<[string | undefined, boolean]>([
    [undefined, true],
    ["http://127.0.0.1:8899", true],
    ["http://localhost:8899", true],
    ["HTTP://LOCALHOST:8899", true],
    ["http://127.0.0.1:8898", false],
    ["https://127.0.0.1:8899", false],
    ["http://127.0.0.1:8899/", false],
    ["http://evil.test", false],
    ["null", false],
    ["vscode-webview://x", false],
    ["", false],
  ])("Origin %j → %s", (origin, allowed) => {
    expect(isAllowedOrigin(origin, PORT)).toBe(allowed);
  });
});

describe("isAllowedFetchSite", () => {
  it.each<[string, { "sec-fetch-site"?: string; "sec-fetch-mode"?: string }, boolean]>([
    ["a non-browser client (no Sec-Fetch headers)", {}, true],
    ["a same-origin fetch", { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }, true],
    ["a same-origin WebSocket", { "sec-fetch-site": "same-origin", "sec-fetch-mode": "websocket" }, true],
    ["a user-initiated navigation", { "sec-fetch-site": "none", "sec-fetch-mode": "navigate" }, true],
    ["the cross-site webview iframe navigation", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }, true],
    ["a cross-site fetch", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" }, false],
    ["a cross-site WebSocket", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "websocket" }, false],
    ["a cross-site subresource", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" }, false],
    ["a same-site fetch from another localhost port", { "sec-fetch-site": "same-site", "sec-fetch-mode": "cors" }, false],
    ["a cross-site request without a mode", { "sec-fetch-site": "cross-site" }, false],
  ])("%s → %s", (_label, headers, allowed) => {
    expect(isAllowedFetchSite(headers)).toBe(allowed);
  });
});

describe("authorizationToken", () => {
  it.each<[string | undefined, string | undefined]>([
    ["token abc", "abc"],
    ["Token abc", "abc"],
    ["TOKEN   abc  ", "abc"],
    ["Bearer abc", undefined],
    ["Basic dXNlcjpwdw==", undefined],
    ["tokenabc", undefined],
    ["token", undefined],
    ["", undefined],
    [undefined, undefined],
  ])("Authorization %j → %j", (header, token) => {
    expect(authorizationToken(header)).toBe(token);
  });
});

describe("readCookie", () => {
  it.each<[string | undefined, string | undefined]>([
    ["cloudru_shim_8899=abc", "abc"],
    ["_xsrf=x; cloudru_shim_8899=abc; other=1", "abc"],
    ["  _xsrf=x ;cloudru_shim_8899 = abc ;other=1", "abc"],
    ["cloudru_shim_8899=a=b", "a=b"],
    ["cloudru_shim_88990=abc", undefined],
    ["xcloudru_shim_8899=abc", undefined],
    ["_xsrf=x", undefined],
    ["", undefined],
    [undefined, undefined],
  ])("Cookie %j → %j", (header, value) => {
    expect(readCookie(header, "cloudru_shim_8899")).toBe(value);
  });
});

describe("isShimCookie", () => {
  it.each<[string, boolean]>([
    ["cloudru_shim_1=evil; Path=/", true],
    [" cloudru_shim_8899=x", true],
    ["_xsrf=abc; Path=/", false],
    ["Cloudru_Shim_1=x", false],
    ["session=cloudru_shim_1", false],
    ["flag; Path=/cloudru_shim_1=x", false],
  ])("%j → %s", (cookie, shim) => {
    expect(isShimCookie(cookie)).toBe(shim);
  });
});

describe("withoutShimCookies", () => {
  it.each<[string | undefined, string | undefined]>([
    ["cloudru_shim_8899=abc; _xsrf=x", "_xsrf=x"],
    ["_xsrf=x;cloudru_shim_8899=abc;  other=1", "_xsrf=x; other=1"],
    ["cloudru_shim_8899=abc; cloudru_shim_8900=def; _xsrf=x", "_xsrf=x"],
    ["_xsrf=x; other=1", "_xsrf=x; other=1"],
    ["cloudru_shim_8899=abc", undefined],
    ["cloudru_shim_8899=abc; cloudru_shim_8900=def", undefined],
    ["", undefined],
    [undefined, undefined],
  ])("Cookie %j → %j", (header, rest) => {
    expect(withoutShimCookies(header)).toBe(rest);
  });
});

describe("splitCredentials", () => {
  it.each<[string, Credentials]>([
    ["/lab", { cleanUrl: "/lab" }],
    ["/lab?reset", { cleanUrl: "/lab?reset" }],
    ["/lab?cloudru_shim=s3cret", { bootstrap: "s3cret", cleanUrl: "/lab" }],
    ["/lab?cloudru_shim=s3cret&x=1", { bootstrap: "s3cret", cleanUrl: "/lab?x=1" }],
    ["/api/kernels?token=t0k&a=b", { token: "t0k", cleanUrl: "/api/kernels?a=b" }],
    ["/x?a=1&token=t&b=2&cloudru_shim=s&c=3", { bootstrap: "s", token: "t", cleanUrl: "/x?a=1&b=2&c=3" }],
    [
      "/api/kernels/k/channels?session_id=abc&token=t",
      { token: "t", cleanUrl: "/api/kernels/k/channels?session_id=abc" },
    ],
    ["/x?token=", { token: "", cleanUrl: "/x" }],
    ["/x?%74oken=t", { token: "t", cleanUrl: "/x" }],
    ["/.//evil.test/?cloudru_shim=s", { bootstrap: "s", cleanUrl: "/evil.test/" }],
    ["http://evil.test/lab?cloudru_shim=s", { bootstrap: "s", cleanUrl: "/lab" }],
  ])("%s", (url, expected) => {
    expect(splitCredentials(url)).toEqual(expected);
  });

  it("throws on a target the URL parser rejects", () => {
    expect(() => splitCredentials("//a:b/x?token=t")).toThrow();
  });
});

describe("tokenMatches", () => {
  // 0xfb bytes encode to "-_v7…", so the secret exercises the URL-safe alphabet.
  const secret = Buffer.alloc(32, 0xfb);
  const token = secret.toString("base64url");

  it.each<[string, string | undefined, boolean]>([
    ["the secret", token, true],
    ["another secret of the same length", Buffer.alloc(32, 0xfa).toString("base64url"), false],
    ["a truncated secret", token.slice(0, -1), false],
    ["the secret plus a byte", Buffer.concat([secret, Buffer.from([0])]).toString("base64url"), false],
    ["the secret in the standard base64 alphabet", secret.toString("base64"), false],
    ["the padded secret", `${token}=`, false],
    ["the secret with surrounding whitespace", ` ${token} `, false],
    ["an empty string", "", false],
    ["no candidate", undefined, false],
  ])("%s → %s", (_label, candidate, matches) => {
    expect(tokenMatches(candidate, secret)).toBe(matches);
  });

  it("matches nothing against an empty secret", () => {
    expect(tokenMatches("A", Buffer.alloc(0))).toBe(false);
  });
});
