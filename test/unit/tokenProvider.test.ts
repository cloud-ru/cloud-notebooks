import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// tokenProvider imports `vscode` (an ambient host API, not an npm package) and `puppeteer-core`.
// Shim both so the expiry FSM can be exercised without a real editor host or browser launch.
const {
  showWarningMessage, showErrorMessage, showInformationMessage, executeCommand, settings, findChrome, launch,
  windowState, windowListeners, profile,
} = vi.hoisted(() => ({
    showWarningMessage: vi.fn<[string, ...string[]], Promise<string | undefined>>(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
    showInformationMessage: vi.fn(async () => undefined),
    executeCommand: vi.fn(async () => undefined),
    settings: new Map<string, unknown>(),
    findChrome: vi.fn<() => string | undefined>(() => undefined),
    launch: vi.fn(),
    windowState: { focused: true, active: true },
    windowListeners: [] as Array<(state: { focused: boolean; active: boolean }) => void>,
    profile: { dir: "" },
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
    ProgressLocation: { Notification: 15 },
    commands: { executeCommand },
    window: {
      showWarningMessage, showErrorMessage, showInformationMessage,
      withProgress: (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) =>
        task({}, { onCancellationRequested: () => ({ dispose() {} }) }),
      get state() { return windowState; },
      onDidChangeWindowState: (listener: (state: { focused: boolean; active: boolean }) => void) => {
        windowListeners.push(listener);
        return { dispose() {} };
      },
    },
    workspace: {
      getConfiguration: () => ({ get: (key: string, def?: unknown) => (settings.has(key) ? settings.get(key) : def) }),
    },
    Uri: { joinPath: () => ({ fsPath: profile.dir }) },
  };
});

vi.mock("../../src/jupyter/chrome", () => ({ findChrome }));
vi.mock("puppeteer-core", () => ({ default: { launch } }));

import { ConsoleTokenProvider, NotSignedInError } from "../../src/console/tokenProvider";
import { jwtAccountFingerprint } from "../../src/auth/jwt";

const SIGNED_IN_KEY = "cloudru.console.signedIn";
const ACCOUNT_KEY = "cloudru.console.account";

// Every test gets its own browser profile directory (the provider writes a marker file into it).
beforeEach(() => {
  profile.dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudru-profile-"));
  Object.assign(windowState, { focused: true, active: true });
  windowListeners.length = 0;
});
afterEach(() => fs.rmSync(profile.dir, { recursive: true, force: true }));

function makeProvider(initialSignedIn: boolean) {
  return makeProviderWithStore(initialSignedIn).provider;
}

function makeProviderWithStore(initialSignedIn: boolean) {
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
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { provider: new ConsoleTokenProvider({ context, logger: logger as never }), store, logger };
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

/** JWT whose `exp` is `seconds` after the (possibly faked) current time. */
function jwt(seconds: number, claims: Record<string, unknown> = {}): string {
  const exp = Math.floor(Date.now() / 1000) + seconds;
  return `h.${Buffer.from(JSON.stringify({ exp, ...claims })).toString("base64url")}.s`;
}

type FakeCookie = { name: string; value: string; domain: string };

/** Fake browser whose console page exposes the session cookie `cookie()` returns on each CDP read. */
function fakeBrowser(cookie: () => string | undefined) {
  return fakeBrowserWithCookies(() => {
    const value = cookie();
    return value ? [{ name: "iframe_auth_cookie", value, domain: "console.cloud.ru" }] : [];
  });
}

function fakeBrowserWithCookies(cookies: () => FakeCookie[]) {
  return {
    close: vi.fn(async () => {}),
    pages: async () => [{
      target: () => ({ createCDPSession: async () => ({ send: async () => ({ cookies: cookies() }) }) }),
      goto: async () => {},
    }],
  };
}

describe("ConsoleTokenProvider background keep-alive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T09:00:00Z"));
    launch.mockReset();
    findChrome.mockReturnValue("/fake/chrome");
    showWarningMessage.mockClear();
    settings.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("refreshes the token when it falls due, with no signing-in signal", async () => {
    // The console SPA issues a fresh ~5-minute token on every page load.
    launch.mockImplementation(async () => fakeBrowser(() => jwt(300)));
    const provider = makeProvider(true);
    const minting: boolean[] = [];
    provider.onDidChangeMinting((active) => minting.push(active));
    provider.startKeepAlive();

    await vi.advanceTimersByTimeAsync(15_000); // first check: nothing cached yet
    expect(launch).toHaveBeenCalledTimes(1);
    const first = await provider.getAccessToken();
    // Due at exp − 30 s = 270 s after the mint, i.e. exactly when getAccessToken would stop serving it.
    await vi.advanceTimersByTimeAsync(269_000);
    expect(launch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(launch).toHaveBeenCalledTimes(2);

    const second = await provider.getAccessToken();
    expect(second).not.toBe(first);
    expect(launch).toHaveBeenCalledTimes(2); // API calls are served from the refreshed cache
    expect(minting).toEqual([]);
    provider.dispose();
  });

  it("keeps the user signed in through transient failures and retries", async () => {
    launch
      .mockRejectedValueOnce(new Error("profile is busy"))
      .mockImplementation(async () => fakeBrowser(() => jwt(300)));
    const provider = makeProvider(true);
    const fired: boolean[] = [];
    provider.onDidChangeAuth((signedIn) => fired.push(signedIn));
    provider.startKeepAlive();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(provider.signedIn).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(launch).toHaveBeenCalledTimes(2);
    await provider.getAccessToken();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(fired).toEqual([]);
    expect(showWarningMessage).not.toHaveBeenCalled();
    provider.dispose();
  });

  it("confirms a missing token once, then signs out and stops", async () => {
    launch.mockImplementation(async () => fakeBrowser(() => undefined)); // SSO session is gone
    const provider = makeProvider(true);
    const fired: boolean[] = [];
    provider.onDidChangeAuth((signedIn) => fired.push(signedIn));
    provider.startKeepAlive();

    await vi.advanceTimersByTimeAsync(15_000 + 35_000); // first check + the 30 s cookie wait
    expect(launch).toHaveBeenCalledTimes(1);
    expect(provider.signedIn).toBe(true); // one miss may be a flaky network right after wake-up
    expect(showWarningMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000 + 35_000);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(provider.signedIn).toBe(false);
    expect(provider.sessionExpired).toBe(true);
    expect(fired).toEqual([false]);
    expect(showWarningMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(launch).toHaveBeenCalledTimes(2); // paused until the next sign-in
    provider.dispose();
  });

  it("stays idle while signed out and resumes after sign-in", async () => {
    launch.mockImplementation(async () => fakeBrowser(() => jwt(300)));
    const provider = makeProvider(false);
    provider.startKeepAlive();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(launch).not.toHaveBeenCalled();

    expect(await provider.signIn()).toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(271_000);
    expect(launch).toHaveBeenCalledTimes(2);
    provider.dispose();
  });

  it("launches nothing when disabled in settings", async () => {
    settings.set("console.keepSessionAlive", false);
    launch.mockImplementation(async () => fakeBrowser(() => jwt(300)));
    const provider = makeProvider(true);
    provider.startKeepAlive();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(launch).not.toHaveBeenCalled();
    provider.dispose();
  });

  it("stops on sign-out", async () => {
    launch.mockImplementation(async () => fakeBrowser(() => jwt(300)));
    const provider = makeProvider(true);
    provider.startKeepAlive();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(launch).toHaveBeenCalledTimes(1);
    await provider.signOut();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(launch).toHaveBeenCalledTimes(1);
    provider.dispose();
  });
});

describe("ConsoleTokenProvider sign-in entry points", () => {
  beforeEach(() => {
    launch.mockReset();
    findChrome.mockReturnValue("/fake/chrome");
    showWarningMessage.mockReset();
    showInformationMessage.mockClear();
    executeCommand.mockClear();
  });

  it("does not open a second browser window while one is waiting for the user", async () => {
    let openWindow!: () => void;
    launch.mockImplementationOnce(() => new Promise((resolve) => {
      openWindow = () => resolve(fakeBrowser(() => jwt(300)));
    }));
    const provider = makeProvider(false);
    const first = provider.signIn();
    while (!launch.mock.calls.length) await Promise.resolve();

    expect(await provider.signIn()).toBe(false);
    expect(showInformationMessage).toHaveBeenCalledTimes(1);
    openWindow();
    expect(await first).toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it("routes the expiry toast's «Войти» through the shared sign-in command", async () => {
    showWarningMessage.mockResolvedValueOnce("Войти");
    const provider = makeProvider(true);
    await provider.handleExpiredSession();
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledWith("cloudru.signIn"));
    provider.dispose();
  });
});

describe("ConsoleTokenProvider profile cookie store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    launch.mockReset();
    findChrome.mockReturnValue("/fake/chrome");
    showWarningMessage.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("lets Chrome encrypt cookies with the OS store instead of the fixed key", async () => {
    launch.mockImplementation(async () => fakeBrowser(() => jwt(300)));
    const provider = makeProvider(true);
    await provider.getAccessToken();
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      ignoreDefaultArgs: ["--use-mock-keychain", "--password-store=basic"],
    }));
    provider.dispose();
  });

  it("drops cookies saved under the fixed key and explains the one-time sign-in", async () => {
    const cookies = path.join(profile.dir, "Default", "Network", "Cookies");
    const localStorage = path.join(profile.dir, "Default", "Local Storage", "leveldb", "000001.log");
    for (const file of [cookies, localStorage]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "x");
    }
    launch.mockImplementation(async () => fakeBrowser(() => undefined)); // the SSO cookies are gone
    const provider = makeProvider(true);

    const pending = expect(provider.getAccessToken()).rejects.toBeInstanceOf(NotSignedInError);
    await vi.advanceTimersByTimeAsync(31_000);
    await pending;
    expect(fs.existsSync(cookies)).toBe(false);
    expect(fs.existsSync(localStorage)).toBe(true);
    expect(showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("защищённое хранилище"), "Войти");
    provider.dispose();
  });

  it("uses the usual expiry text once the store has been switched", async () => {
    launch.mockImplementation(async () => fakeBrowser(() => undefined));
    const provider = makeProvider(true); // empty profile: nothing to drop
    const pending = expect(provider.getAccessToken()).rejects.toBeInstanceOf(NotSignedInError);
    await vi.advanceTimersByTimeAsync(31_000);
    await pending;
    expect(showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("Сессия Cloud.ru истекла"), "Войти");
    provider.dispose();
  });
});

describe("ConsoleTokenProvider keep-alive on an unattended machine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T09:00:00Z"));
    launch.mockReset();
    findChrome.mockReturnValue("/fake/chrome");
    settings.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("pauses after 8 hours without activity and resumes on the next one", async () => {
    windowState.active = false; // window left open (and focused) in front of an empty desk
    launch.mockImplementation(async () => fakeBrowser(() => jwt(300)));
    const provider = makeProvider(true);
    provider.startKeepAlive();

    await vi.advanceTimersByTimeAsync(8 * 60 * 60_000 + 5 * 60_000);
    const atLimit = launch.mock.calls.length;
    expect(atLimit).toBeGreaterThan(90); // kept alive all along until the limit
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(launch).toHaveBeenCalledTimes(atLimit); // then the IdP idle timeout may end the session

    for (const listener of windowListeners) listener({ focused: true, active: true });
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
    expect(launch.mock.calls.length).toBeGreaterThan(atLimit);
    provider.dispose();
  });

  it("keeps going while the user is active", async () => {
    launch.mockImplementation(async () => fakeBrowser(() => jwt(300)));
    const provider = makeProvider(true);
    provider.startKeepAlive();
    await vi.advanceTimersByTimeAsync(9 * 60 * 60_000);
    const count = launch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(launch.mock.calls.length).toBeGreaterThan(count);
    provider.dispose();
  });
});

describe("ConsoleTokenProvider account pinning", () => {
  const user = { iss: "https://id.cloud.ru/auth/system", sub: "user-1" };
  const other = { iss: "https://id.cloud.ru/auth/system", sub: "attacker" };

  beforeEach(() => {
    vi.useFakeTimers();
    launch.mockReset();
    findChrome.mockReturnValue("/fake/chrome");
    showWarningMessage.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("prefers the console's own cookie over one set on a parent domain", async () => {
    const own = jwt(300, user);
    launch.mockImplementation(async () => fakeBrowserWithCookies(() => [
      { name: "iframe_auth_cookie", value: jwt(300, other), domain: ".cloud.ru" },
      { name: "iframe_auth_cookie", value: own, domain: "console.cloud.ru" },
    ]));
    const provider = makeProvider(true);
    expect(await provider.getAccessToken()).toBe(own);
    provider.dispose();
  });

  it("pins the account at sign-in and refuses a refresh token for another account", async () => {
    let current = jwt(300, user);
    launch.mockImplementation(async () => fakeBrowser(() => current));
    const { provider, store, logger } = makeProviderWithStore(false);
    expect(await provider.signIn()).toBe(true);
    expect(store.get(ACCOUNT_KEY)).toBe(jwtAccountFingerprint(current));
    expect(String(store.get(ACCOUNT_KEY))).not.toContain("user-1"); // hashed, not the raw user id

    current = jwt(300, other); // e.g. planted by another *.cloud.ru site
    const pending = expect(provider.getAccessToken(true)).rejects.toBeInstanceOf(NotSignedInError);
    await vi.advanceTimersByTimeAsync(31_000);
    await pending;
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("another account"));
    expect(provider.signedIn).toBe(false);
    provider.dispose();
  });

  it("accepts the same account's refreshed token", async () => {
    let current = jwt(300, user);
    launch.mockImplementation(async () => fakeBrowser(() => current));
    const provider = makeProvider(false);
    await provider.signIn();
    current = jwt(600, user);
    expect(await provider.getAccessToken(true)).toBe(current);
    provider.dispose();
  });

  it("pins sessions from older versions on their first refresh", async () => {
    let current = jwt(300, user);
    launch.mockImplementation(async () => fakeBrowser(() => current));
    const { provider, store } = makeProviderWithStore(true); // signed in, nothing pinned yet
    await provider.getAccessToken();
    expect(store.get(ACCOUNT_KEY)).toBe(jwtAccountFingerprint(current));
    current = jwt(300, other);
    const pending = expect(provider.getAccessToken(true)).rejects.toBeInstanceOf(NotSignedInError);
    await vi.advanceTimersByTimeAsync(31_000);
    await pending;
    provider.dispose();
  });

  it("re-pins when the user signs in with another account, and forgets it on sign-out", async () => {
    let current = jwt(300, user);
    launch.mockImplementation(async () => fakeBrowser(() => current));
    const { provider, store } = makeProviderWithStore(false);
    await provider.signIn();
    current = jwt(300, other);
    await provider.signIn();
    expect(store.get(ACCOUNT_KEY)).toBe(jwtAccountFingerprint(current));
    await provider.signOut();
    expect(store.get(ACCOUNT_KEY)).toBeUndefined();
    provider.dispose();
  });

  it("does not pin tokens without a subject", async () => {
    let current = jwt(300, user);
    launch.mockImplementation(async () => fakeBrowser(() => current));
    const { provider, store } = makeProviderWithStore(false);
    await provider.signIn();
    current = jwt(300); // no `sub`: a sign-in clears the pin instead of locking every refresh out
    await provider.signIn();
    expect(store.get(ACCOUNT_KEY)).toBeUndefined();
    current = jwt(600);
    expect(await provider.getAccessToken(true)).toBe(current);
    provider.dispose();
  });
});
