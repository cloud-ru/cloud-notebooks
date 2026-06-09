import { describe, expect, it } from "vitest";
import { apiErrorFromResponse, extractDetail, parseRetryAfter } from "../../src/api/errors";

describe("apiErrorFromResponse", () => {
  it.each([
    [401, "auth"],
    [403, "forbidden"],
    [404, "notFound"],
    [429, "rateLimit"],
    [500, "backend"],
    [503, "backend"],
    [418, "unknown"],
  ])("maps status %i to kind %s", (status, kind) => {
    expect(apiErrorFromResponse(status, {}).kind).toBe(kind);
  });

  it("includes the body detail in the message", () => {
    const err = apiErrorFromResponse(403, { detail: "no access to workspace" });
    expect(err.message).toContain("no access to workspace");
  });
});

describe("extractDetail", () => {
  it("reads common error fields", () => {
    expect(extractDetail({ detail: "a" })).toBe("a");
    expect(extractDetail({ error_message: "b" })).toBe("b");
    expect(extractDetail({ message: "c" })).toBe("c");
    expect(extractDetail("plain")).toBe("plain");
    expect(extractDetail({})).toBeUndefined();
    expect(extractDetail(null)).toBeUndefined();
  });
});

describe("parseRetryAfter", () => {
  it("parses numeric seconds", () => {
    expect(parseRetryAfter("30")).toBe(30);
  });

  it("parses an HTTP date into seconds from now", () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const secs = parseRetryAfter(future);
    expect(secs).toBeGreaterThanOrEqual(8);
    expect(secs).toBeLessThanOrEqual(11);
  });

  it("returns undefined for junk or missing values", () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("not-a-date")).toBeUndefined();
  });
});
