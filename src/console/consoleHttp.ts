// Minimal HTTP(S) client for the console API. We deliberately do NOT use the global `fetch`: behind a
// corporate TLS-inspection proxy Node's bundled CA list rejects the re-signed certificate ("fetch
// failed"), exactly the problem the notebook shim already solves. Reusing `createUpstreamAgent` makes
// these calls trust the system CA store the same way. Pure (no `vscode`) → unit-testable.
import * as http from "node:http";
import * as https from "node:https";
import * as zlib from "node:zlib";
import { ApiError } from "../api/errors";
import { createUpstreamAgent } from "../jupyter/upstreamAgent";

/** Default per-request timeout. A hung socket (corporate proxy, dropped network) otherwise wedges the
 * tree spinner and `pollUntil` forever — see improvement-plan H1. */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

export interface HttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}

export type HttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; timeoutMs?: number },
) => Promise<HttpResponse>;

// One agent for the process; it snapshots the system CA store once (see createUpstreamAgent).
const agent = createUpstreamAgent(true);

export const consoleFetch: HttpFetch = (url, init) => {
  const { promise, resolve, reject } = Promise.withResolvers<HttpResponse>();
  const target = new URL(url);
  const isHttps = target.protocol === "https:";
  const transport = isHttps ? https : http;
  const timeoutMs = init.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const req = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: target.pathname + target.search,
      method: init.method,
      headers: init.headers,
      agent: isHttps ? agent : undefined,
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: async () => decode(Buffer.concat(chunks), res.headers["content-encoding"]),
          headers: { get: (name) => headerValue(res.headers[name.toLowerCase()]) },
        });
      });
    },
  );
  // A stuck socket must not hang the extension forever: abort and surface a clear network error.
  req.setTimeout(timeoutMs, () => {
    req.destroy();
    reject(new ApiError("network", `Cloud.ru API не отвечает (таймаут ${Math.round(timeoutMs / 1000)} с)`));
  });
  req.on("error", reject);
  if (init.body !== undefined) req.write(init.body);
  req.end();
  return promise;
};

function decode(body: Buffer, encoding: string | undefined): string {
  switch (encoding) {
    case "gzip":
      return zlib.gunzipSync(body).toString("utf8");
    case "deflate":
      return zlib.inflateSync(body).toString("utf8");
    case "br":
      return zlib.brotliDecompressSync(body).toString("utf8");
    default:
      return body.toString("utf8");
  }
}

function headerValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}
