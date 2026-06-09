import { describe, expect, it } from "vitest";
import { formatHostStanza, upsertSshConfigBlock } from "../../src/ssh/sshConfigFile";

const entry = {
  host: "ssh-a100-jupyter.ai.cloud.ru",
  port: 2222,
  username: "nb.ai0000000-00000",
  identityFile: "/keys/mlspace key (1).txt",
};

describe("formatHostStanza", () => {
  it("quotes paths and forces ssh-rsa + accept-new", () => {
    const stanza = formatHostStanza("cloudru-x", entry, "/g/known_hosts");
    expect(stanza).toContain("Host cloudru-x");
    expect(stanza).toContain("HostName ssh-a100-jupyter.ai.cloud.ru");
    expect(stanza).toContain('IdentityFile "/keys/mlspace key (1).txt"');
    expect(stanza).toContain("HostKeyAlgorithms +ssh-rsa");
    expect(stanza).toContain("StrictHostKeyChecking accept-new");
    expect(stanza).toContain('UserKnownHostsFile "/g/known_hosts"');
  });
});

describe("upsertSshConfigBlock", () => {
  it("appends a managed block to an empty config", () => {
    const out = upsertSshConfigBlock("", "cloudru-x", "Host cloudru-x\n  Port 2222");
    expect(out).toContain("# >>> cloud.ru:cloudru-x >>>");
    expect(out).toContain("Host cloudru-x");
    expect(out).toContain("# <<< cloud.ru:cloudru-x <<<");
  });

  it("preserves unrelated existing content and appends", () => {
    const existing = "Host my-server\n  HostName example.com\n";
    const out = upsertSshConfigBlock(existing, "cloudru-x", "Host cloudru-x\n  Port 2222");
    expect(out).toContain("Host my-server");
    expect(out).toContain("Host cloudru-x");
  });

  it("replaces the existing managed block for the same alias (idempotent)", () => {
    const first = upsertSshConfigBlock("", "cloudru-x", "Host cloudru-x\n  Port 2222");
    const second = upsertSshConfigBlock(first, "cloudru-x", "Host cloudru-x\n  Port 9999");
    expect(second).toContain("Port 9999");
    expect(second).not.toContain("Port 2222");
    expect(second.match(/# >>> cloud\.ru:cloudru-x >>>/g)).toHaveLength(1);
  });

  it("does not touch a different alias's block", () => {
    const withX = upsertSshConfigBlock("", "cloudru-x", "Host cloudru-x\n  Port 1");
    const withBoth = upsertSshConfigBlock(withX, "cloudru-y", "Host cloudru-y\n  Port 2");
    expect(withBoth).toContain("cloudru-x");
    expect(withBoth).toContain("cloudru-y");
  });
});
