import * as http from "node:http";
import type { AddressInfo } from "node:net";
import httpProxy from "http-proxy";
import {
  mergeCookieHeader,
  rewriteSetCookieForLocalhost,
  stripFramingHeaders,
  type MutableHeaders,
} from "./headerRewrite";
import { createUpstreamAgent } from "./upstreamAgent";

export interface NotebookShimOptions {
  /** Upstream origin, e.g. https://k2-nb.ai.cloud.ru */
  origin: string;
  /** Returns the current `authservice_session=...` cookie to inject on every upstream request. */
  getSessionCookie: () => string;
  /** Invoked when the upstream redirects to the OIDC login, i.e. the session expired. */
  onAuthExpired: () => void;
  /** Reports upstream/proxy failures for diagnostics. */
  onError: (error: Error) => void;
  /** Trace each proxied response (method, path, status) for diagnostics. */
  onTrace?: (method: string, url: string, status: number) => void;
  /** Verify the upstream TLS certificate. Set false only for isolated/inspected networks. */
  tlsVerify: boolean;
}

/**
 * Local reverse proxy (127.0.0.1 only) that lets the notebook web UI render inside a VS Code webview
 * iframe. It injects the captured OIDC session cookie, proxies HTTP + WebSocket to the notebook
 * origin, and rewrites responses so the browser can frame and store cookies over http://127.0.0.1:
 *   - strips `X-Frame-Options` and the CSP `frame-ancestors` directive,
 *   - removes `Secure`/`Domain` from Set-Cookie (downgrades SameSite=None).
 */
export class NotebookShim {
  private readonly proxy: httpProxy;
  private readonly server: http.Server;
  private url = "";

  constructor(opts: NotebookShimOptions) {
    this.proxy = httpProxy.createProxyServer({
      target: opts.origin,
      changeOrigin: true,
      secure: opts.tlsVerify,
      agent: createUpstreamAgent(opts.tlsVerify),
      ws: true,
      autoRewrite: false,
      followRedirects: false,
      proxyTimeout: 20_000,
      timeout: 20_000,
    });

    this.proxy.on("proxyReq", (proxyReq, req) => {
      proxyReq.setHeader("cookie", mergeCookieHeader(req.headers.cookie, opts.getSessionCookie()));
    });
    this.proxy.on("proxyReqWs", (proxyReq, req) => {
      proxyReq.setHeader("cookie", mergeCookieHeader(req.headers.cookie, opts.getSessionCookie()));
    });
    this.proxy.on("proxyRes", (proxyRes, req) => {
      stripFramingHeaders(proxyRes.headers as MutableHeaders);
      const setCookie = proxyRes.headers["set-cookie"];
      if (setCookie) proxyRes.headers["set-cookie"] = rewriteSetCookieForLocalhost(setCookie);
      opts.onTrace?.(req.method ?? "?", req.url ?? "?", proxyRes.statusCode ?? 0);

      const location = proxyRes.headers["location"];
      if (proxyRes.statusCode === 302 && typeof location === "string" && location.includes("id.cloud.ru")) {
        opts.onAuthExpired();
      }
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
    this.server.close();
    this.proxy.close();
  }
}
