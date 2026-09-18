import { afterEach, describe, expect, it, vi } from "vitest";

const focus = vi.hoisted(() => ({ listener: (_state: { focused: boolean }) => undefined }));
vi.mock("vscode", () => ({ window: {
  state: { focused: true },
  onDidChangeWindowState: (listener: (state: { focused: boolean }) => void) => {
    focus.listener = listener;
    return { dispose() { focus.listener = () => undefined; } };
  },
} }));
import { AutoRefresh } from "../../src/views/autoRefresh";

afterEach(() => vi.useRealTimers());

describe("AutoRefresh", () => {
  it("does not publish a refresh after disposal during the active check", async () => {
    vi.useFakeTimers();
    let complete!: (active: boolean) => void;
    const active = new Promise<boolean>((resolve) => { complete = resolve; });
    const refresh = vi.fn();
    const loop = new AutoRefresh({ isActive: () => active, hasBusy: () => true, refresh });
    loop.start();
    await vi.advanceTimersByTimeAsync(15_000);
    loop.dispose();
    complete(true);
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes immediately when the editor regains focus", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const loop = new AutoRefresh({ isActive: async () => true, hasBusy: () => false, refresh });
    loop.start();
    focus.listener({ focused: true });
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    loop.dispose();
  });
});
