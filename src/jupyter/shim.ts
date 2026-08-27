import * as http from "node:http";
import type { AddressInfo } from "node:net";
import httpProxy from "http-proxy";
import { rewriteSetCookieForLocalhost, stripFramingHeaders, type MutableHeaders } from "./headerRewrite";

export interface NotebookShimOptions {
  /** Upstream origin to proxy to, e.g. http://127.0.0.1:<ssh-forwarded-port>. */
  origin: string;
  /** Reports upstream/proxy failures for diagnostics. */
  onError: (error: Error) => void;
  /** Trace each proxied response (method, path, status) for diagnostics. */
  onTrace?: (method: string, url: string, status: number) => void;
}

/**
 * Local reverse proxy (127.0.0.1 only) that lets the notebook web UI render inside a VS Code webview
 * iframe. The upstream is the pod's JupyterLab reached over the SSH tunnel, so the proxy's only job is
 * to rewrite responses so the browser can frame the page and keep cookies over http://127.0.0.1:
 *   - strips `X-Frame-Options` and the CSP `frame-ancestors` directive,
 *   - removes `Secure`/`Domain` from Set-Cookie (downgrades SameSite=None to Lax).
 */
export class NotebookShim {
  private readonly proxy: httpProxy;
  private readonly server: http.Server;
  private url = "";

  constructor(opts: NotebookShimOptions) {
    this.proxy = httpProxy.createProxyServer({
      target: opts.origin,
      changeOrigin: true,
      ws: true,
      autoRewrite: false,
      followRedirects: false,
      proxyTimeout: 60_000,
      timeout: 60_000,
    });

    this.proxy.on("proxyRes", (proxyRes, req) => {
      stripFramingHeaders(proxyRes.headers as MutableHeaders);
      const setCookie = proxyRes.headers["set-cookie"];
      if (setCookie) proxyRes.headers["set-cookie"] = rewriteSetCookieForLocalhost(setCookie);
      opts.onTrace?.(req.method ?? "?", req.url ?? "?", proxyRes.statusCode ?? 0);
    });
    this.proxy.on("error", (err, _req, res) => {
      opts.onError(err instanceof Error ? err : new Error(String(err)));
      const response = res as http.ServerResponse | undefined;
      if (response && typeof response.writeHead === "function" && !response.headersSent) {
        response.writeHead(502, { "content-type": "text/plain" });
        response.end(`Cloud.ru notebook proxy error: ${(err as Error).message}`);
      }
    });

    this.server = http.createServer((req, res) => this.proxy.web(req, res));
    this.server.on("upgrade", (req, socket, head) => this.proxy.ws(req, socket, head));
  }

  /** Starts listening on an ephemeral localhost port and returns the local base URL. */
  async start(): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.server.once("error", reject);
    this.server.listen(0, "127.0.0.1", resolve);
    await promise;
    const address = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${address.port}`;
    return this.url;
  }

  get baseUrl(): string {
    return this.url;
  }

  dispose(): void {
    // closeAllConnections matters: proxied WebSocket/kernel sockets are long-lived, and plain
    // close() only stops new accepts while keeping live handles (and the extension host) busy.
    this.server.close();
    this.server.closeAllConnections();
    this.proxy.close();
  }
}
