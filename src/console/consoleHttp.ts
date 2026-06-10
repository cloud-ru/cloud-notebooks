// Minimal HTTPS client for the console API. We deliberately do NOT use the global `fetch`: behind a
// corporate TLS-inspection proxy Node's bundled CA list rejects the re-signed certificate ("fetch
// failed"), exactly the problem the notebook shim already solves. Reusing `createUpstreamAgent` makes
// these calls trust the system CA store the same way. Pure (no `vscode`) → unit-testable.
import * as https from "node:https";
import * as zlib from "node:zlib";
import { createUpstreamAgent } from "../jupyter/upstreamAgent";

export interface HttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}

export type HttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<HttpResponse>;

// One agent for the process; it snapshots the system CA store once (see createUpstreamAgent).
const agent = createUpstreamAgent(true);

export const consoleFetch: HttpFetch = (url, init) => {
  const { promise, resolve, reject } = Promise.withResolvers<HttpResponse>();
  const target = new URL(url);
  const req = https.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: target.pathname + target.search,
      method: init.method,
      headers: init.headers,
      agent,
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
