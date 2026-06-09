import { describe, expect, it } from "vitest";
import {
  buildUsername,
  deriveSshHost,
  parseSshCommand,
  sshPoolFromNotebookUrl,
} from "../../src/ssh/sshUrl";

describe("parseSshCommand", () => {
  it("parses the real console command", () => {
    const cmd =
      "ssh my-notebook-server.ai0000000-00000@ssh-a100-jupyter.ai.cloud.ru -p 2222 -i <path/to/key>";
    expect(parseSshCommand(cmd)).toEqual({
      host: "ssh-a100-jupyter.ai.cloud.ru",
      port: 2222,
      serverName: "my-notebook-server",
      accountId: "ai0000000-00000",
    });
  });

  it("parses a command with RSA options and a different pool", () => {
    const cmd =
      "ssh -o HostkeyAlgorithms=+ssh-rsa buckets.ai0000000-11111@ssh-sr002-jupyter.ai.cloud.ru -p 2222 -i k";
    const parsed = parseSshCommand(cmd);
    expect(parsed?.host).toBe("ssh-sr002-jupyter.ai.cloud.ru");
    expect(parsed?.serverName).toBe("buckets");
    expect(parsed?.accountId).toBe("ai0000000-11111");
  });

  it("returns undefined when there is no user@host or no dot in the user", () => {
    expect(parseSshCommand("ssh nope")).toBeUndefined();
    expect(parseSshCommand("ssh nodot@host -p 2222")).toBeUndefined();
  });
});

describe("sshPoolFromNotebookUrl", () => {
  it("extracts the pool and strips the -mt suffix", () => {
    expect(sshPoolFromNotebookUrl("https://k2-nb.ai.cloud.ru/a100-mt/notebook/abc/")).toBe("a100");
  });
});

describe("deriveSshHost", () => {
  it("fills the host template from the notebook pool", () => {
    expect(deriveSshHost("https://k2-nb.ai.cloud.ru/a100-mt/notebook/abc/lab")).toBe(
      "ssh-a100-jupyter.ai.cloud.ru",
    );
  });
});

describe("buildUsername", () => {
  it("joins server name and account id with a dot", () => {
    expect(buildUsername("srv", "ai0000000-00000")).toBe("srv.ai0000000-00000");
  });
});
