import { randomBytes } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import httpProxy from "http-proxy";
import { rewriteSetCookieForLocalhost, stripFramingHeaders, type MutableHeaders } from "./headerRewrite";
import {
  BOOTSTRAP_PARAM,
  authorizationToken,
  cookieName,
  isAllowedFetchSite,
  isAllowedHost,
  isAllowedOrigin,
  isShimCookie,
  readCookie,
  splitCredentials,
  tokenMatches,
  withoutShimCookies,
  type Credentials,
} from "./shimAuth";

export interface NotebookShimOptions {
  /** Pod-side Jupyter address, e.g. http://127.0.0.1:8888 — reached only through `agent`. */
  upstream: string;
  /** Opens every upstream connection as an in-process SSH channel (`createSshTunnelAgent`). */
  agent: http.Agent;
  /** Reports upstream/proxy failures for diagnostics. */
  onError: (error: Error) => void;
  /** Trace each proxied response (method, credential-free path, status) for diagnostics. */
  onTrace?: (method: string, url: string, status: number) => void;
}

type Verdict = { ok: true; url: string } | { ok: false };

const DENIED: Verdict = { ok: false };
const FORBIDDEN_UPGRADE = "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

/**
 * Local reverse proxy (127.0.0.1 only) in front of the pod's JupyterLab, reached through in-process SSH
 * channels. It serves both the notebook webview (JupyterLab framed in an iframe) and the VS Code Jupyter
 * extension's kernel connections.
 *
 * Trust boundary: the pod's JupyterLab runs without a token and any local process or web page can reach
 * a localhost port, so the shim admits only clients holding its per-instance 256-bit secret:
 *   - the notebook webview: the iframe `src` carries `?cloudru_shim=<secret>`, which the shim trades for
 *     an HttpOnly cookie in a 302 that drops the parameter; the framed page then sends the cookie;
 *   - the Jupyter extension: `Authorization: token <secret>` (HTTP) or `?token=<secret>` (WebSockets).
 * Whatever the credential, a request is refused with 403 before the pod is contacted when its Host is not
 * 127.0.0.1/localhost:<port> (DNS rebinding), its Origin is foreign (cross-origin fetches and WebSockets,
 * other webviews, sandboxed "null" origins) or it is cross-site without being a navigation (Sec-Fetch),
 * so no other page can make the browser replay the cookie. Every credential is stripped before
 * forwarding and the pod cannot set `cloudru_shim_*` cookies, so the secret never reaches the pod.
 * The cookie's `SameSite=None; Secure; Partitioned` only let Chromium keep it inside the cross-site
 * webview iframe; they are not the security boundary — the secret and the Host/Origin/Sec-Fetch checks are.
 *
 * Responses are rewritten so the browser can frame the page and keep cookies over http://127.0.0.1:
 *   - strips `X-Frame-Options` and the CSP `frame-ancestors` directive,
 *   - removes `Secure`/`Domain` from Set-Cookie (downgrades SameSite=None to Lax).
 */
export class NotebookShim {
  private readonly secret = randomBytes(32);
  private readonly proxy: httpProxy;
  private readonly server: http.Server;
  /** Upgraded (WebSocket/kernel) sockets: the HTTP server stops tracking them, so `dispose` closes them. */
  private readonly upgraded = new Set<Duplex>();
  private port = 0;

  constructor(opts: NotebookShimOptions) {
    this.proxy = httpProxy.createProxyServer({
      target: opts.upstream,
      agent: opts.agent,
      changeOrigin: true,
      ws: true,
      // Absolute redirects to the pod-side address would send clients past the shim to a local port
      // nobody (or something else) listens on; point them back at the (already validated) Host.
      autoRewrite: true,
      followRedirects: false,
      proxyTimeout: 60_000,
      timeout: 60_000,
    });

    this.proxy.on("proxyRes", (proxyRes, req) => {
      stripFramingHeaders(proxyRes.headers as MutableHeaders);
      const setCookie = proxyRes.headers["set-cookie"]?.filter((line) => !isShimCookie(line));
      if (setCookie?.length) proxyRes.headers["set-cookie"] = rewriteSetCookieForLocalhost(setCookie);
      else delete proxyRes.headers["set-cookie"];
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

    this.server = http.createServer((req, res) => this.onRequest(req, res));
    this.server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
  }

  /** Starts listening on an ephemeral localhost port and returns the local base URL. */
  async start(): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.server.once("error", reject);
    this.server.listen(0, "127.0.0.1", () => {
      // Set before any request can arrive: the Host/Origin checks and the cookie name depend on it.
      this.port = (this.server.address() as AddressInfo).port;
      resolve();
    });
    await promise;
    return this.baseUrl;
  }

  get baseUrl(): string {
    return this.port ? `http://127.0.0.1:${this.port}` : "";
  }

  /** The credential: base64url of the 256-bit secret (the Jupyter server token for the kernel picker). */
  get token(): string {
    return this.secret.toString("base64url");
  }

  /** `cloudru_shim=<token>`: append to the webview iframe `src` only, never to anything that is logged. */
  get bootstrapQuery(): string {
    return `${BOOTSTRAP_PARAM}=${this.token}`;
  }

  /** Jupyter-style credential header for local probes of this shim. */
  get authHeaders(): Record<string, string> {
    return { authorization: `token ${this.token}` };
  }

  dispose(): void {
    // close() only stops new accepts; closeAllConnections() drops the HTTP sockets, including
    // keep-alive ones that would keep the extension host busy. Upgraded sockets are not tracked by the
    // HTTP server any more, so long-lived kernel WebSockets are closed explicitly.
    this.server.close();
    this.server.closeAllConnections();
    for (const socket of this.upgraded) socket.destroy();
    this.proxy.close();
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const credentials = this.screen(req);
    if (!credentials) {
      forbid(res);
      return;
    }
    if (credentials.bootstrap !== undefined) {
      this.bootstrap(res, credentials.bootstrap, credentials.cleanUrl);
      return;
    }
    const verdict = this.authorize(req, credentials);
    if (!verdict.ok) {
      forbid(res);
      return;
    }
    req.url = verdict.url; // the pod and onTrace only ever see the credential-free target
    this.proxy.web(req, res);
  }

  private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    // The HTTP server has detached its listeners from an upgraded socket: without this one, a client
    // reset would surface as an uncaught exception in the extension host.
    socket.on("error", () => socket.destroy());
    this.upgraded.add(socket);
    socket.once("close", () => this.upgraded.delete(socket));
    const credentials = this.screen(req);
    const verdict = credentials ? this.authorize(req, credentials) : DENIED;
    if (!verdict.ok) {
      socket.end(FORBIDDEN_UPGRADE, () => socket.destroy());
      return;
    }
    req.url = verdict.url;
    this.proxy.ws(req, socket, head);
  }

  /**
   * Checks every HTTP and WebSocket request gets before its credential — Host, Origin and Sec-Fetch, which
   * only the webview frame and the extension host pass — then splits the credentials off the target.
   * `undefined` means refuse, also for a target the URL parser rejects.
   */
  private screen(req: http.IncomingMessage): Credentials | undefined {
    if (!isAllowedHost(req.headers.host, this.port)) return undefined;
    if (!isAllowedOrigin(req.headers.origin, this.port)) return undefined;
    if (!isAllowedFetchSite(req.headers)) return undefined;
    try {
      return splitCredentials(req.url ?? "/");
    } catch {
      return undefined;
    }
  }

  /**
   * Accept when any credential matches the secret — token header, `?token=`, or this shim's cookie — and
   * strip every credential so the pod never sees one. Takes the already split target so the HTTP handler
   * can branch on the bootstrap parameter without parsing it twice.
   */
  private authorize(req: http.IncomingMessage, credentials: Credentials): Verdict {
    const headerToken = authorizationToken(req.headers.authorization);
    const cookie = req.headers.cookie;
    const authorized =
      tokenMatches(headerToken, this.secret) ||
      tokenMatches(credentials.token, this.secret) ||
      tokenMatches(readCookie(cookie, cookieName(this.port)), this.secret);
    if (!authorized) return DENIED;
    if (headerToken !== undefined) delete req.headers.authorization;
    const rest = withoutShimCookies(cookie);
    if (rest === undefined) delete req.headers.cookie;
    else req.headers.cookie = rest;
    return { ok: true, url: credentials.cleanUrl };
  }

  /**
   * Webview bootstrap: trade the `?cloudru_shim=` secret from the iframe `src` for a cookie and redirect
   * to the same target without it, so the secret leaves the frame URL. The pod is never contacted.
   */
  private bootstrap(res: http.ServerResponse, candidate: string, location: string): void {
    if (!tokenMatches(candidate, this.secret)) {
      forbid(res);
      return;
    }
    res.writeHead(302, {
      location,
      "cache-control": "no-store",
      // Attributes for the cross-site webview iframe only (Chromium accepts Secure on http://127.0.0.1);
      // the secret and the request checks are the security boundary, not these.
      "set-cookie": `${cookieName(this.port)}=${this.token}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`,
    });
    res.end();
  }
}

function forbid(res: http.ServerResponse): void {
  res.writeHead(403, { "content-type": "text/plain" });
  res.end("Forbidden");
}
