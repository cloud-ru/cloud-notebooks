import { describe, expect, it } from "vitest";
import { labPath, parseNotebookUrl } from "../../src/jupyter/notebookUrl";

describe("parseNotebookUrl", () => {
  it("keeps the mount prefix for a server-root URL", () => {
    const loc = parseNotebookUrl("https://k2-nb.ai.cloud.ru/a100-mt/notebook/abc/");
    expect(loc.origin).toBe("https://k2-nb.ai.cloud.ru");
    expect(loc.prefix).toBe("/a100-mt/notebook/abc/");
  });

  it("strips a trailing /lab", () => {
    const loc = parseNotebookUrl("https://k2-nb.ai.cloud.ru/a100-mt/notebook/abc/lab");
    expect(loc.prefix).toBe("/a100-mt/notebook/abc/");
  });

  it("strips a trailing /tree/", () => {
    const loc = parseNotebookUrl("https://h/x/notebook/abc/tree/");
    expect(loc.prefix).toBe("/x/notebook/abc/");
  });

  it("adds a trailing slash when missing", () => {
    const loc = parseNotebookUrl("https://h/x/notebook/abc");
    expect(loc.prefix).toBe("/x/notebook/abc/");
  });
});

describe("labPath", () => {
  it("appends lab to the prefix", () => {
    expect(labPath("/a100-mt/notebook/abc/")).toBe("/a100-mt/notebook/abc/lab");
  });
});
