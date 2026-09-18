import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ window: { createOutputChannel: vi.fn() } }));
import { scrubSecrets } from "../../src/util/logger";

describe("Output redaction", () => {
  it("removes URL tokens, headers, and private keys while retaining the request path", () => {
    const input = [
      "GET /api/notebook?token=secret123&trace=ok",
      "Authorization: Bearer abc.def",
      "Cookie: session=abc; other=123",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "supersecret",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const result = scrubSecrets(input);
    expect(result).toContain("/api/notebook?token=<redacted>&trace=ok");
    expect(result).not.toMatch(/secret123|abc\.def|session=abc|supersecret/);
    expect(result).toContain("<private key redacted>");
  });
});
