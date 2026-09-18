import { beforeEach, describe, expect, it, vi } from "vitest";
import { utils as sshUtils } from "ssh2";

const ui = vi.hoisted(() => ({
  open: undefined as undefined | Array<{ fsPath: string }>,
  confirm: "Загрузить" as string | undefined,
  keyPath: "/fake/key",
  files: new Map<string, Buffer | string>(),
  update: vi.fn(async (_key: string, value: string) => { ui.keyPath = value; }),
}));
vi.mock("node:fs", () => ({
  readFileSync: () => Buffer.from("private-key"),
  promises: {
    readFile: async (name: string) => {
      const value = ui.files.get(name);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return value;
    },
  },
}));
vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1 },
  window: {
    showOpenDialog: vi.fn(async () => ui.open),
    showWarningMessage: vi.fn(async () => ui.confirm),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    withProgress: vi.fn(async (_opts, work) => work()),
  },
  workspace: { getConfiguration: () => ({
    get: (key: string, fallback: unknown) => key === "ssh.privateKeyPath" ? ui.keyPath : fallback,
    update: ui.update,
  }) },
}));

import { SshConfig } from "../../src/ssh/sshConfig";

function setup() {
  const values = new Map<string, unknown>();
  let workspace = { workspaceId: "A", workspaceName: "A", namespace: "accountA" };
  let signedIn = true;
  let generation = 1;
  const client = {
    getSshGatewayConfig: vi.fn(async () => ({ url: "gateway", port: 2222 })),
    uploadUserPublicKey: vi.fn(),
  };
  const context = { globalState: {
    get: (key: string, fallback: unknown) => values.get(key) ?? fallback,
    update: async (key: string, value: unknown) => { values.set(key, value); },
  } };
  const config = new SshConfig(context as never, {
    client: client as never,
    getWorkspace: () => workspace,
    getGeneration: () => generation,
    isSignedIn: async () => signedIn,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  });
  return {
    config, values, client,
    selectB: () => { workspace = { workspaceId: "B", workspaceName: "B", namespace: "accountB" }; generation++; },
    signOut: () => { signedIn = false; generation++; },
  };
}

describe("SshConfig context ownership", () => {
  beforeEach(() => { vi.clearAllMocks(); ui.files.clear(); ui.open = undefined; ui.keyPath = "/fake/key"; });
  it("does not restore a target from another workspace or after logout", async () => {
    const state = setup();
    state.values.set("cloudru.ssh.targets", {
      nb: { workspaceId: "A", host: "old", port: 2222, username: "nb.accountA" },
    });
    state.selectB();
    expect(await state.config.resolveSilently("nb")).toBeUndefined();
    state.signOut();
    expect(await state.config.resolveSilently("nb")).toBeUndefined();
  });

  it("ignores an override from another workspace in the same region", async () => {
    const state = setup();
    state.values.set("cloudru.ssh.endpoints", {
      [JSON.stringify(["A", "accountA", "SR008"])]: { host: "old-gateway", port: 2222, accountId: "accountA" },
    });
    state.selectB();
    const target = await state.config.resolveTarget({
      uid: "nb", name: "nb", status: "running", region: "SR008", url: "https://example.com/sr008-mt/notebook/nb",
    } as never, { interactive: false });
    expect(target).toMatchObject({ host: "gateway", username: "nb.accountB" });
    expect(state.client.getSshGatewayConfig).toHaveBeenCalledTimes(1);
  });

  it("drops a Remote-SSH entry resolved after the workspace changed", async () => {
    const state = setup();
    const gateway = Promise.withResolvers<{ url: string; port: number }>();
    state.client.getSshGatewayConfig.mockImplementationOnce(() => gateway.promise);
    const pending = state.config.resolveConfigEntry({
      uid: "nb", name: "nb", status: "running", region: "SR008", url: "https://example.com/sr008-mt/notebook/nb",
    } as never);
    await vi.waitFor(() => expect(state.client.getSshGatewayConfig).toHaveBeenCalledTimes(1));
    state.selectB();
    gateway.resolve({ url: "old-gateway", port: 2222 });
    expect(await pending).toBeUndefined();
  });

  it("keeps endpoints and targets when configuring SSH is cancelled", async () => {
    const state = setup();
    state.values.set("cloudru.ssh.endpoints", { current: { host: "gateway" } });
    state.values.set("cloudru.ssh.targets", { current: { host: "gateway" } });
    ui.open = undefined;
    expect(await state.config.configure()).toBe(false);
    expect(state.values.get("cloudru.ssh.endpoints")).toHaveProperty("current");
    expect(state.values.get("cloudru.ssh.targets")).toHaveProperty("current");
  });

  it("checks the private half before uploading a public key", async () => {
    const state = setup();
    const first = sshUtils.generateKeyPairSync("ed25519");
    const second = sshUtils.generateKeyPairSync("ed25519");
    ui.files.set("/test.pub", first.public);
    ui.files.set("/test.key", second.private);
    ui.open = [{ fsPath: "/test.pub" }];
    const open = (await import("vscode")).window.showOpenDialog as ReturnType<typeof vi.fn>;
    open.mockResolvedValueOnce([{ fsPath: "/test.pub" }]).mockResolvedValueOnce([{ fsPath: "/test.key" }]);
    expect(await state.config.uploadOwnPublicKey()).toBeUndefined();
    expect(state.client.uploadUserPublicKey).not.toHaveBeenCalled();
    expect(ui.update).not.toHaveBeenCalled();
  });

  it("pins the first SSH host key and refuses a changed one", async () => {
    const state = setup();
    ui.confirm = "Доверять ключу";
    const key = sshUtils.parseKey(sshUtils.generateKeyPairSync("ed25519").public);
    if (key instanceof Error) throw key;
    const wireKey = key.getPublicSSH();
    expect(await state.config.verifyHostKey("gateway", 2222, wireKey)).toBe(true);
    expect(await state.config.verifyHostKey("gateway", 2222, wireKey)).toBe(true);
    expect(await state.config.verifyHostKey("gateway", 2222, Buffer.from("other-host-key"))).toBe(false);
    expect(state.config.trustedHostKeyLine("gateway", 2222)).toBe(`[gateway]:2222 ssh-ed25519 ${wireKey.toString("base64")}`);
    expect(state.values.get("cloudru.ssh.hostKeys")).toEqual({
      [JSON.stringify(["gateway", 2222])]: wireKey.toString("base64"),
    });
  });
});
