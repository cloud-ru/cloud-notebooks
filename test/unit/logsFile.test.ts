import { describe, expect, it } from "vitest";
import { isoDaysAgo, parseDownloadFileName } from "../../src/console/logsFile";

describe("parseDownloadFileName", () => {
  it("parses the RFC 5987 UTF-8 form", () => {
    const header = "attachment; filename*=UTF-8''%D0%BB%D0%BE%D0%B3%D0%B8.txt";
    expect(parseDownloadFileName(header, "nb")).toBe("логи.txt");
  });

  it("parses the plain quoted form", () => {
    expect(parseDownloadFileName('attachment; filename="logs-2026-08-27.txt"', "nb")).toBe(
      "logs-2026-08-27.txt",
    );
  });

  it("parses the plain unquoted form", () => {
    expect(parseDownloadFileName("attachment; filename=logs.txt; size=10", "nb")).toBe("logs.txt");
  });

  it("falls back to <notebookName>.txt without a header or a parsable name", () => {
    expect(parseDownloadFileName(undefined, "nb")).toBe("nb.txt");
    expect(parseDownloadFileName(null, "nb")).toBe("nb.txt");
    expect(parseDownloadFileName("", "nb")).toBe("nb.txt");
    expect(parseDownloadFileName("attachment", "my-nb")).toBe("my-nb.txt");
  });

  it("does not throw on malformed percent-encoding and falls back", () => {
    expect(parseDownloadFileName("attachment; filename*=UTF-8''%ZZ", "nb")).toBe("nb.txt");
  });
});

describe("isoDaysAgo", () => {
  it("subtracts whole days from now", () => {
    const now = Date.UTC(2026, 7, 27, 12, 0, 0);
    expect(isoDaysAgo(1, now)).toBe(new Date(now - 24 * 3600 * 1000).toISOString());
    expect(isoDaysAgo(7, now)).toBe(new Date(now - 7 * 24 * 3600 * 1000).toISOString());
  });
});
