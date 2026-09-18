import * as vscode from "vscode";
import { randomBytes } from "node:crypto";

const panelSources = new WeakMap<vscode.WebviewPanel, string>();

/** Opens (or reveals) a webview editor that frames the notebook UI served by the local shim. */
export function openNotebookPanel(opts: {
  title: string;
  frameSrc: string;
  frameOrigin: string;
  existing?: vscode.WebviewPanel | undefined;
  onRetry?: () => void;
  onShowOutput?: () => void;
}): vscode.WebviewPanel {
  if (opts.existing) {
    if (panelSources.get(opts.existing) !== opts.frameSrc) {
      opts.existing.webview.html = renderHtml(opts.frameSrc, opts.frameOrigin);
      panelSources.set(opts.existing, opts.frameSrc);
    }
    opts.existing.reveal(vscode.ViewColumn.Active);
    return opts.existing;
  }
  const panel = vscode.window.createWebviewPanel(
    "cloudruNotebook",
    opts.title,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = renderHtml(opts.frameSrc, opts.frameOrigin);
  panelSources.set(panel, opts.frameSrc);
  panel.webview.onDidReceiveMessage((message: { type?: string }) => {
    if (message.type === "retry") opts.onRetry?.();
    else if (message.type === "output") opts.onShowOutput?.();
  });
  return panel;
}

export function renderHtml(frameSrc: string, frameOrigin: string): string {
  const nonce = randomBytes(16).toString("base64");
  // Allow framing the shim origin (http://127.0.0.1:<port> locally, or the asExternalUri tunnel host).
  const csp = [
    "default-src 'none'",
    `frame-src ${frameOrigin} http://127.0.0.1:* http://localhost:*`,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <style>
      html, body { margin: 0; padding: 0; height: 100%; width: 100%; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); }
      iframe { border: 0; height: 100vh; width: 100vw; display: block; }
      #status { position: absolute; inset: 0; display: grid; place-content: center; gap: 12px; background: var(--vscode-editor-background); text-align: center; z-index: 1; }
      #status[hidden] { display: none; }
      button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 8px 12px; cursor: pointer; }
      button:hover { background: var(--vscode-button-hoverBackground); }
    </style>
  </head>
  <body>
    <div id="status" role="status" aria-live="polite"><span id="statusText">Загружаем приложение ноутбука…</span><div><button id="retry" type="button">Подключиться снова</button> <button id="output" type="button">Открыть диагностику</button></div></div>
    <iframe id="notebook" title="Приложение ноутбука Cloud.ru" src="${escapeHtml(frameSrc)}" allow="clipboard-read; clipboard-write; cross-origin-isolated"></iframe>
    <script nonce="${nonce}">
      const api = acquireVsCodeApi();
      const frame = document.getElementById('notebook');
      const status = document.getElementById('status');
      const statusText = document.getElementById('statusText');
      let disconnected = false;
      frame.addEventListener('load', () => { if (!disconnected) status.hidden = true; });
      frame.addEventListener('error', () => { disconnected = true; status.hidden = false; statusText.textContent = 'Не удалось загрузить страницу ноутбука.'; });
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'disconnected') {
          disconnected = true;
          status.hidden = false;
          statusText.textContent = 'Соединение с ноутбуком потеряно.';
        }
      });
      document.getElementById('retry').addEventListener('click', () => api.postMessage({ type: 'retry' }));
      document.getElementById('output').addEventListener('click', () => api.postMessage({ type: 'output' }));
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
