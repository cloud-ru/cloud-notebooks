import { describe, expect, it } from "vitest";
import { buildUsername, parseSshCommand, regionTypeFromNotebookUrl } from "../../src/ssh/sshUrl";

describe("parseSshCommand", () => {
  it("parses the default-region command (no pool segment)", () => {
    const cmd = "ssh test-name.ai0001011-00055@ssh-jupyter.ai.cloud.ru -p 2222 -i <path/to/key>";
    expect(parseSshCommand(cmd)).toEqual({
      host: "ssh-jupyter.ai.cloud.ru",
      port: 2222,
      serverName: "test-name",
      accountId: "ai0001011-00055",
    });
  });

  it("parses a command with RSA options and a region segment", () => {
    const cmd =
      "ssh -o HostkeyAlgorithms=+ssh-rsa buckets.ai0001011-11111@ssh-sr002-jupyter.ai.cloud.ru -p 2222 -i k";
    expect(parseSshCommand(cmd)).toEqual({
      host: "ssh-sr002-jupyter.ai.cloud.ru",
      port: 2222,
      serverName: "buckets",
      accountId: "ai0001011-11111",
    });
  });

  it("defaults the port when -p is absent", () => {
    expect(parseSshCommand("ssh name.ai0001011-00055@ssh-jupyter.ai.cloud.ru")?.port).toBe(2222);
  });

  it("returns undefined when there is no user@host or no dot in the user", () => {
    expect(parseSshCommand("ssh nope")).toBeUndefined();
    expect(parseSshCommand("ssh nodot@host -p 2222")).toBeUndefined();
  });
});

describe("buildUsername", () => {
  it("joins server name and account id with a dot", () => {
    expect(buildUsername("srv", "ai0001905-05529")).toBe("srv.ai0001905-05529");
  });
});

describe("regionTypeFromNotebookUrl", () => {
  it("reads the region type from the URL prefix suffix", () => {
    expect(regionTypeFromNotebookUrl("https://k2-nb.ai.cloud.ru/a100-mt/notebook/abc/lab")).toBe("MT");
  });

  it("defaults to MT when the prefix has no suffix or the url is missing/unparseable", () => {
    expect(regionTypeFromNotebookUrl("https://k2-nb.ai.cloud.ru/notebook/abc/")).toBe("MT");
    expect(regionTypeFromNotebookUrl(undefined)).toBe("MT");
    expect(regionTypeFromNotebookUrl("not a url")).toBe("MT");
    expect(regionTypeFromNotebookUrl("my-nb.sr004-nb.ai.cloud.ru")).toBe("MT");
  });
});
