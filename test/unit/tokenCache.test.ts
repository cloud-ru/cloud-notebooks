import { describe, expect, it } from "vitest";
import { TokenCache } from "../../src/auth/tokenCache";

describe("TokenCache", () => {
  it("returns the token before expiry (minus skew)", () => {
    const cache = new TokenCache(60_000);
    const t0 = 1_000_000;
    cache.set("tok", 3600, t0); // valid until t0 + 3_600_000, usable until t0 + 3_540_000
    expect(cache.get(t0)).toBe("tok");
    expect(cache.get(t0 + 3_000_000)).toBe("tok");
  });

  it("treats the token as expired within the skew window", () => {
    const cache = new TokenCache(60_000);
    const t0 = 1_000_000;
    cache.set("tok", 3600, t0);
    expect(cache.get(t0 + 3_550_000)).toBeUndefined(); // inside the 60s skew
    expect(cache.get(t0 + 3_600_001)).toBeUndefined(); // past real expiry
  });

  it("returns undefined after clear", () => {
    const cache = new TokenCache();
    cache.set("tok", 3600);
    cache.clear();
    expect(cache.get()).toBeUndefined();
  });

  it("returns undefined when empty", () => {
    expect(new TokenCache().get()).toBeUndefined();
  });
});
