import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/errors";
import { consoleFetch } from "../../src/console/consoleHttp";

const servers: http.Server[] = [];

/** Start an HTTP server on an ephemeral 127.0.0.1 port and resolve with that port. */
function startServer(handler: http.RequestListener): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>();
  const server = http.createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1", () => {
    resolve((server.address() as AddressInfo).port);
  });
  return promise;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      // Drop any sockets the client left open (keep-alive / hung request) so close() returns promptly.
      server.closeAllConnections();
      server.close(() => resolve());
      return promise;
    }),
  );
});

describe("consoleFetch timeout", () => {
  it(
    "rejects with a network ApiError when the socket never responds",
    async () => {
      // Accept the connection but never write a response: the request must abort on its own timeout.
      const port = await startServer(() => {
        /* intentionally silent — no res.end() */
      });

      const error = await consoleFetch(`http://127.0.0.1:${port}/`, {
        method: "GET",
        headers: {},
        timeoutMs: 100,
      }).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.kind).toBe("network");
      // Sub-second timeouts round to 0 s; the message is the Russian user-facing string.
      expect(apiError.message).toBe("Cloud.ru API не отвечает (таймаут 0 с)");
    },
    2000,
  );
});

describe("consoleFetch response", () => {
  it("resolves ok/status/text and does case-insensitive header lookup for a 200 body", async () => {
    const payload = JSON.stringify({ hello: "мир", n: 42 });
    const port = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
    });

    const res = await consoleFetch(`http://127.0.0.1:${port}/notebooks`, {
      method: "GET",
      headers: { connection: "close" },
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(payload);
    // headers.get lower-cases the lookup name, so a mixed-case query still hits.
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("x-absent")).toBeNull();
  });

  it("reports ok === false for a non-2xx status", async () => {
    const body = JSON.stringify({ detail: "нет доступа" });
    const port = await startServer((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(body);
    });

    const res = await consoleFetch(`http://127.0.0.1:${port}/missing`, {
      method: "GET",
      headers: { connection: "close" },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(body);
  });

  it("transparently gunzips a gzip-encoded body", async () => {
    const raw = JSON.stringify({ data: [1, 2, 3], note: "сжато" });
    const gzipped = zlib.gzipSync(raw);
    const port = await startServer((_req, res) => {
      res.writeHead(200, { "content-encoding": "gzip", "content-type": "application/json" });
      res.end(gzipped);
    });

    const res = await consoleFetch(`http://127.0.0.1:${port}/`, {
      method: "GET",
      headers: { connection: "close" },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(raw);
  });
});
