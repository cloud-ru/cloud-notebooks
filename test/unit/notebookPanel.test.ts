import { beforeEach, describe, expect, it, vi } from "vitest";

const { createPanel } = vi.hoisted(() => ({ createPanel: vi.fn() }));
vi.mock("vscode", () => ({
  ViewColumn: { Active: 1 },
  window: { createWebviewPanel: createPanel },
}));

import { openNotebookPanel, renderHtml } from "../../src/jupyter/notebookPanel";

describe("notebook webview", () => {
  beforeEach(() => { createPanel.mockReset(); });

  it("renders a themed loading and recovery screen with an accessible frame", () => {
    const html = renderHtml('http://localhost:1234/?x="', "http://localhost:1234");
    expect(html).toContain("var(--vscode-editor-background)");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('title="Приложение ноутбука Cloud.ru"');
    expect(html).toContain('src="http://localhost:1234/?x=&quot;"');
    expect(html).toContain("Соединение с ноутбуком потеряно");
  });

  it("routes retry and diagnostics, retaining a working iframe when reopened", () => {
    let onMessage: (message: { type: string }) => void = () => undefined;
    const webview = { html: "", onDidReceiveMessage: vi.fn((callback) => { onMessage = callback; }) };
    const panel = { webview, reveal: vi.fn() };
    createPanel.mockReturnValue(panel);
    const retry = vi.fn();
    const output = vi.fn();
    const options = { title: "nb", frameSrc: "http://localhost:1234/", frameOrigin: "http://localhost:1234", onRetry: retry, onShowOutput: output };
    const created = openNotebookPanel(options) as never;
    const firstHtml = webview.html;
    onMessage({ type: "retry" });
    onMessage({ type: "output" });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledTimes(1);
    openNotebookPanel({ ...options, existing: created });
    expect(webview.html).toBe(firstHtml);
    expect(panel.reveal).toHaveBeenCalled();
  });
});
