import { describe, expect, it, vi } from "vitest";

// tokenProvider imports `vscode` (an ambient host API, not an npm package) and `puppeteer-core`.
// Shim both so the expiry FSM can be exercised without a real editor host or browser launch.
const { showWarningMessage, showErrorMessage } = vi.hoisted(() => ({
  showWarningMessage: vi.fn(async () => undefined),
  showErrorMessage: vi.fn(async () => undefined),
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
  };
});

// No browser available → the silent (headless) mint fails fast, modelling an expired SSO session.
vi.mock("../../src/jupyter/chrome", () => ({ findChrome: () => undefined }));
vi.mock("puppeteer-core", () => ({ default: { launch: vi.fn() } }));

import { ConsoleTokenProvider, NotSignedInError } from "../../src/console/tokenProvider";

const SIGNED_IN_KEY = "cloudru.console.signedIn";

function makeProvider(initialSignedIn: boolean) {
  const store = new Map<string, unknown>([[SIGNED_IN_KEY, initialSignedIn]]);
  const context = {
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
  it("flips to signed-out, fires the auth-change once, and prompts re-auth when a silent mint fails", async () => {
    showWarningMessage.mockClear();
    const provider = makeProvider(true);
    const fired: boolean[] = [];
    provider.onDidChangeAuth((signedIn) => fired.push(signedIn));

    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(NotSignedInError);

    expect(await provider.isSignedIn()).toBe(false); // welcome view / guards now short-circuit
    expect(fired).toEqual([false]); // drives setContext + tree/server refresh in extension.ts
    expect(showWarningMessage).toHaveBeenCalledTimes(1); // actionable "Sign In" notification
  });

  it("only announces the expiry once across repeated failures (no toast storm)", async () => {
    showWarningMessage.mockClear();
    const provider = makeProvider(true);
    const fired: boolean[] = [];
    provider.onDidChangeAuth((signedIn) => fired.push(signedIn));

    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(NotSignedInError);
    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(NotSignedInError);

    expect(fired).toEqual([false]); // second failure stays silent — already signed out
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
  });
});
