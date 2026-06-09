import { describe, expect, it } from "vitest";
import { parseAccessKey } from "../../src/auth/credentialInput";

describe("parseAccessKey", () => {
  it("parses KEY_ID:KEY_SECRET", () => {
    expect(parseAccessKey("  abc-123 : s3cr3t ")).toEqual({ clientId: "abc-123", clientSecret: "s3cr3t" });
  });

  it("keeps colons inside the secret (splits on the first only)", () => {
    expect(parseAccessKey("id:a:b:c")).toEqual({ clientId: "id", clientSecret: "a:b:c" });
  });

  it("parses console JSON with client_id/client_secret", () => {
    const raw = JSON.stringify({ client_id: "cid", client_secret: "csec" });
    expect(parseAccessKey(raw)).toEqual({ clientId: "cid", clientSecret: "csec" });
  });

  it("parses JSON with key_id/secret aliases", () => {
    const raw = JSON.stringify({ key_id: "kid", secret: "ksec", extra: 1 });
    expect(parseAccessKey(raw)).toEqual({ clientId: "kid", clientSecret: "ksec" });
  });

  it("returns undefined for unusable input", () => {
    expect(parseAccessKey("")).toBeUndefined();
    expect(parseAccessKey("   ")).toBeUndefined();
    expect(parseAccessKey("just-a-secret")).toBeUndefined();
    expect(parseAccessKey(":nokey")).toBeUndefined();
    expect(parseAccessKey("noteborder:")).toBeUndefined();
    expect(parseAccessKey("{not json")).toBeUndefined();
    expect(parseAccessKey(JSON.stringify({ client_id: "only-id" }))).toBeUndefined();
  });
});
