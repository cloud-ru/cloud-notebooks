import * as vscode from "vscode";

/** Opens (or reveals) a webview editor that frames the notebook UI served by the local shim. */
export function openNotebookPanel(opts: {
  title: string;
  iframeUrl: string;
  existing?: vscode.WebviewPanel | undefined;
}): vscode.WebviewPanel {
  if (opts.existing) {
    opts.existing.reveal(vscode.ViewColumn.Active);
    return opts.existing;
  }
  const panel = vscode.window.createWebviewPanel(
    "cloudruNotebook",
    opts.title,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = renderHtml(opts.iframeUrl);
  return panel;
}

function renderHtml(iframeUrl: string): string {
  // The webview's own CSP must permit framing the localhost shim. The shim has already stripped the
  // upstream X-Frame-Options / frame-ancestors so the inner page renders.
  const csp = [
    "default-src 'none'",
    "frame-src http://127.0.0.1:* http://localhost:*",
    "style-src 'unsafe-inline'",
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <style>
      html, body { margin: 0; padding: 0; height: 100%; width: 100%; overflow: hidden; background: #fff; }
      iframe { border: 0; height: 100vh; width: 100vw; display: block; }
    </style>
  </head>
  <body>
    <iframe src="${iframeUrl}" allow="clipboard-read; clipboard-write; cross-origin-isolated"></iframe>
  </body>
</html>`;
}
