import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const home = vi.hoisted(() => ({ path: "" }));
vi.mock("node:os", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:os")>()), homedir: () => home.path }));
vi.mock("vscode", () => ({}));
import { ensureHostEntry } from "../../src/ssh/remoteSsh";
import { formatHostStanza, upsertSshConfigBlock } from "../../src/ssh/sshConfigFile";

const entry = {
  host: "ssh-jupyter.ai.cloud.ru",
  port: 2222,
  username: "nb.ai0000000-00000",
  identityFile: "/keys/distributed train key (1).txt",
};

describe("formatHostStanza", () => {
  it("quotes paths and requires a pinned host key", () => {
    const stanza = formatHostStanza("cloudru-x", entry, "/g/known_hosts");
    expect(stanza).toContain("Host cloudru-x");
    expect(stanza).toContain("HostName ssh-jupyter.ai.cloud.ru");
    expect(stanza).toContain('IdentityFile "/keys/distributed train key (1).txt"');
    expect(stanza).toContain("HostKeyAlgorithms +ssh-rsa");
    expect(stanza).toContain("StrictHostKeyChecking yes");
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

describe("ensureHostEntry", () => {
  const hostKeyLine = `[${entry.host}]:${entry.port} ssh-ed25519 AAAATEST`;
  const context = { globalStorageUri: { fsPath: "" } };
  beforeEach(async () => {
    home.path = await fs.mkdtemp(path.join(os.tmpdir(), "cloudru-ssh-config-"));
    context.globalStorageUri.fsPath = path.join(home.path, "storage");
  });
  afterEach(async () => { await fs.rm(home.path, { recursive: true, force: true }); });

  it("keeps an unreadable config instead of replacing it", async () => {
    const configPath = path.join(home.path, ".ssh", "config");
    await fs.mkdir(configPath, { recursive: true });
    await expect(ensureHostEntry("cloudru-x", entry, context as never, hostKeyLine)).rejects.toMatchObject({ code: "EISDIR" });
    expect((await fs.stat(configPath)).isDirectory()).toBe(true);
  });

  it("serializes two updates and preserves both host blocks", async () => {
    await Promise.all([
      ensureHostEntry("cloudru-x", entry, context as never, hostKeyLine),
      ensureHostEntry("cloudru-y", entry, context as never, hostKeyLine),
    ]);
    const contents = await fs.readFile(path.join(home.path, ".ssh", "config"), "utf8");
    expect(contents).toContain("Host cloudru-x");
    expect(contents).toContain("Host cloudru-y");
    expect(await fs.readFile(path.join(home.path, "storage", "known_hosts"), "utf8")).toBe(`${hostKeyLine}\n`);
  });

  it("does not write after context changes", async () => {
    await ensureHostEntry("cloudru-x", entry, context as never, hostKeyLine, () => false);
    await expect(fs.readFile(path.join(home.path, ".ssh", "config"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
