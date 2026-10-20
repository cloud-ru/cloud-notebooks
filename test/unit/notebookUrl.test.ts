import { describe, expect, it } from "vitest";
import { labPath, parseNotebookUrl, toAbsoluteNotebookUrl } from "../../src/jupyter/notebookUrl";

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

  it("accepts the new host-only format and mounts the server at the root", () => {
    const loc = parseNotebookUrl("my-notebook-0a1b2c3d.sr004-nb.ai.cloud.ru");
    expect(loc.origin).toBe("https://my-notebook-0a1b2c3d.sr004-nb.ai.cloud.ru");
    expect(loc.prefix).toBe("/");
    expect(labPath(loc.prefix)).toBe("/lab");
  });
});

describe("toAbsoluteNotebookUrl", () => {
  it("keeps a legacy absolute URL as is", () => {
    expect(toAbsoluteNotebookUrl("https://k2-nb.ai.cloud.ru/a100-mt/notebook/abc/")).toBe(
      "https://k2-nb.ai.cloud.ru/a100-mt/notebook/abc/",
    );
    expect(toAbsoluteNotebookUrl("HTTP://example.com/notebook")).toBe("HTTP://example.com/notebook");
  });

  it("adds https and a single trailing slash to a bare host", () => {
    expect(toAbsoluteNotebookUrl("my-nb.sr008-nb.ai.cloud.ru")).toBe("https://my-nb.sr008-nb.ai.cloud.ru/");
    expect(toAbsoluteNotebookUrl("  my-nb.sr008-nb.ai.cloud.ru///  ")).toBe("https://my-nb.sr008-nb.ai.cloud.ru/");
  });
});

describe("labPath", () => {
  it("appends lab to the prefix", () => {
    expect(labPath("/a100-mt/notebook/abc/")).toBe("/a100-mt/notebook/abc/lab");
  });
});
