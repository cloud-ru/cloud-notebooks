import { describe, expect, it, vi } from "vitest";

// tokenProvider imports `vscode` (an ambient host API, not an npm package) and `puppeteer-core`.
// Shim both so the expiry FSM can be exercised without a real editor host or browser launch.
const { showWarningMessage, showErrorMessage, findChrome, launch } = vi.hoisted(() => ({
  showWarningMessage: vi.fn(async () => undefined),
  showErrorMessage: vi.fn(async () => undefined),
  findChrome: vi.fn<() => string | undefined>(() => undefined),
  launch: vi.fn(),
}));
vi.mock("vscode", () => {
  class EventEmitter<T> {
    private readonly listeners: Array<(e: T) => void> = [];
    readonly event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    };
    fire(e: T): void {
      for (const l of this.listeners) l(e);
    }
    dispose(): void {}
  }
  return {
    EventEmitter,
    window: { showWarningMessage, showErrorMessage },
    workspace: { getConfiguration: () => ({ get: (_key: string, def?: unknown) => def }) },
    Uri: { joinPath: () => ({ fsPath: "/tmp/cloudru-token-provider-test" }) },
  };
});

vi.mock("../../src/jupyter/chrome", () => ({ findChrome }));
vi.mock("puppeteer-core", () => ({ default: { launch } }));

import { ConsoleTokenProvider, NotSignedInError } from "../../src/console/tokenProvider";

const SIGNED_IN_KEY = "cloudru.console.signedIn";

function makeProvider(initialSignedIn: boolean) {
  const store = new Map<string, unknown>([[SIGNED_IN_KEY, initialSignedIn]]);
  const context = {
    globalStorageUri: { fsPath: "/tmp" },
    globalState: {
      get: (key: string, def?: unknown) => (store.has(key) ? store.get(key) : def),
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
  } as never;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
  return new ConsoleTokenProvider({ context, logger });
}

describe("ConsoleTokenProvider expired session", () => {
  it("announces concurrent final auth failures once", async () => {
    showWarningMessage.mockClear();
    const provider = makeProvider(true);
    await Promise.all([provider.handleExpiredSession(), provider.handleExpiredSession()]);
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps the session when Chrome is unavailable", async () => {
    showWarningMessage.mockClear();
    findChrome.mockReturnValue(undefined);
    const provider = makeProvider(true);
    const fired: boolean[] = [];
    provider.onDidChangeAuth((signedIn) => fired.push(signedIn));

    await expect(provider.getAccessToken()).rejects.toMatchObject({ name: "TokenMintError" });

    expect(await provider.isSignedIn()).toBe(true);
    expect(fired).toEqual([]);
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it("does not turn repeated missing-browser failures into expiry", async () => {
    showWarningMessage.mockClear();
    findChrome.mockReturnValue(undefined);
    const provider = makeProvider(true);
    const fired: boolean[] = [];
    provider.onDidChangeAuth((signedIn) => fired.push(signedIn));

    await expect(provider.getAccessToken()).rejects.toMatchObject({ name: "TokenMintError" });
    await expect(provider.getAccessToken()).rejects.toMatchObject({ name: "TokenMintError" });

    expect(fired).toEqual([]);
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it("does not restore a token when logout happens during browser launch", async () => {
    findChrome.mockReturnValue("/fake/chrome");
    let finishLaunch!: (browser: unknown) => void;
    launch.mockImplementationOnce(() => new Promise((resolve) => { finishLaunch = resolve; }));
    const close = vi.fn(async () => {});
    const token = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.s`;
    const browser = {
      close,
      pages: async () => [{
        target: () => ({ createCDPSession: async () => ({ send: async () => ({ cookies: [{
          name: "iframe_auth_cookie", value: token, domain: "console.cloud.ru",
        }] }) }) }),
        goto: async () => {},
      }],
    };
    const provider = makeProvider(true);
    const pending = provider.getAccessToken();
    while (!launch.mock.calls.length) await Promise.resolve();
    await provider.signOut();
    finishLaunch(browser);
    await expect(pending).rejects.toBeInstanceOf(NotSignedInError);
    expect(close).toHaveBeenCalled();
    expect(await provider.isSignedIn()).toBe(false);
  });
});
