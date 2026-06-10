import { describe, expect, it } from "vitest";
import { isJwtExpired, jwtExpiryMs } from "../../src/auth/jwt";

function makeJwt(payload: object): string {
  const b64 = (obj: object) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

describe("jwtExpiryMs", () => {
  it("returns exp in ms", () => {
    expect(jwtExpiryMs(makeJwt({ exp: 1781022742 }))).toBe(1781022742000);
  });

  it("returns undefined for malformed tokens", () => {
    expect(jwtExpiryMs("nope")).toBeUndefined();
    expect(jwtExpiryMs(makeJwt({ noexp: 1 }))).toBeUndefined();
  });
});

describe("isJwtExpired", () => {
  const token = makeJwt({ exp: 2000 }); // expires at 2_000_000 ms

  it("is false well before expiry", () => {
    expect(isJwtExpired(token, 30_000, 1_900_000)).toBe(false);
  });

  it("is true within the skew window", () => {
    expect(isJwtExpired(token, 30_000, 1_980_000)).toBe(true);
  });

  it("is true for missing/unparseable tokens", () => {
    expect(isJwtExpired(undefined)).toBe(true);
    expect(isJwtExpired("garbage")).toBe(true);
  });
});
