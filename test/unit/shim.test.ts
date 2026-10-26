import { once } from "node:events";
import * as http from "node:http";
import * as net from "node:net";
import type { Duplex } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NotebookShim } from "../../src/jupyter/shim";

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface RawConnection {
  socket: net.Socket;
  received: () => string;
  closed: Promise<void>;
}

/** Every request the fake pod received, in arrival order. */
const seen: Seen[] = [];
const podSockets = new Set<Duplex>();
const onError = vi.fn();
const onTrace = vi.fn();
let pod: http.Server;
let podPort: number;
let shim: NotebookShim;
let port: number;
let token: string;

async function listen(server: http.Server): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => resolve());
  await promise;
  return (server.address() as net.AddressInfo).port;
}

function newShim(): NotebookShim {
  return new NotebookShim({
    upstream: `http://127.0.0.1:${podPort}`,
    agent: new http.Agent({ keepAlive: false }),
    onError,
    onTrace,
  });
}

/** GET through the shim with exactly these headers (each case sets Host explicitly). */
function get(path: string, headers: http.OutgoingHttpHeaders, target = port): Promise<Reply> {
  const { promise, resolve, reject } = Promise.withResolvers<Reply>();
  const req = http.request({ host: "127.0.0.1", port: target, path, headers, agent: false }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => (body += chunk));
    res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
  });
  req.on("error", reject);
  req.end();
  return promise;
}

/** Raw WebSocket handshake, so the test sees exactly what the shim writes back on the socket. */
async function upgrade(path: string, headers: Record<string, string>, target = port): Promise<RawConnection> {
  const socket = net.connect(target, "127.0.0.1");
  let received = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => (received += chunk));
  socket.on("error", () => socket.destroy());
  const closed = Promise.withResolvers<void>();
  socket.once("close", () => closed.resolve());
  await once(socket, "connect");
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${target}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ];
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  return { socket, received: () => received, closed: closed.promise };
}

/** Resolves when something accepts a TCP connection on the port. */
async function connect(target: number): Promise<void> {
  const socket = net.connect(target, "127.0.0.1");
  try {
    await once(socket, "connect");
  } finally {
    socket.destroy();
  }
}

const host = (): string => `127.0.0.1:${port}`;
const shimCookie = (): string => `cloudru_shim_${port}=${token}`;

function lastSeen(): Seen {
  const request = seen.at(-1);
  if (!request) throw new Error("the pod received no request");
  return request;
}

describe("NotebookShim", () => {
  beforeAll(async () => {
    // Fake pod: records what reaches it, answers with framing/cookie headers the shim must rewrite, and
    // accepts WebSocket upgrades with a greeting.
    pod = http.createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, headers: req.headers });
      res.writeHead(200, {
        "content-type": "text/plain",
        "x-frame-options": "DENY",
        "set-cookie": ["_xsrf=abc; Path=/", "cloudru_shim_1=evil; Path=/"],
      });
      res.end("ok");
    });
    pod.on("upgrade", (req: http.IncomingMessage, socket: Duplex) => {
      seen.push({ method: req.method, url: req.url, headers: req.headers });
      podSockets.add(socket);
      socket.on("error", () => socket.destroy());
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      socket.write("hello");
    });
    podPort = await listen(pod);
    shim = newShim();
    port = Number(new URL(await shim.start()).port);
    token = shim.token;
  });

  afterAll(async () => {
    shim.dispose();
    for (const socket of podSockets) socket.destroy();
    pod.closeAllConnections();
    const { promise, resolve } = Promise.withResolvers<void>();
    pod.close(() => resolve());
    await promise;
  });

  it("hands out a 256-bit base64url credential in the forms its clients send", () => {
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(shim.baseUrl).toBe(`http://127.0.0.1:${port}`);
    expect(shim.bootstrapQuery).toBe(`cloudru_shim=${token}`);
    expect(shim.authHeaders).toEqual({ authorization: `token ${token}` });
  });

  it.each<[string, () => http.OutgoingHttpHeaders]>([
    ["no credential", () => ({ host: host() })],
    ["a wrong token header", () => ({ host: host(), authorization: "token wrong" })],
    ["a wrong cookie", () => ({ host: host(), cookie: `cloudru_shim_${port}=${"A".repeat(43)}` })],
    ["the secret under another shim's cookie name", () => ({ host: host(), cookie: `cloudru_shim_1=${token}` })],
  ])("refuses a request with %s before contacting the pod", async (_label, headers) => {
    const before = seen.length;
    const reply = await get("/lab", headers());
    expect(reply.status).toBe(403);
    expect(reply.headers["content-type"]).toBe("text/plain");
    expect(reply.body).toBe("Forbidden");
    expect(seen.length).toBe(before);
  });

  it("refuses a valid cookie sent with a foreign Host (DNS rebinding)", async () => {
    const before = seen.length;
    const reply = await get("/lab", { host: `evil.test:${port}`, cookie: shimCookie() });
    expect(reply.status).toBe(403);
    expect(seen.length).toBe(before);
  });

  it("accepts the shim's own Origin and refuses a foreign one", async () => {
    const headers = { host: host(), cookie: shimCookie() };
    expect((await get("/api/contents", { ...headers, origin: "http://evil.test" })).status).toBe(403);
    expect((await get("/api/contents", { ...headers, origin: `http://127.0.0.1:${port}` })).status).toBe(200);
  });

  it("trades the bootstrap secret for a cookie without contacting the pod", async () => {
    const before = seen.length;
    const reply = await get(`/lab?cloudru_shim=${token}&x=1`, {
      host: host(),
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "iframe",
    });
    expect(reply.status).toBe(302);
    expect(reply.headers.location).toBe("/lab?x=1");
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.headers["set-cookie"]).toEqual([
      `cloudru_shim_${port}=${token}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`,
    ]);
    expect(seen.length).toBe(before);
  });

  it("refuses a wrong bootstrap secret without a cookie, even next to a valid cookie", async () => {
    const before = seen.length;
    const reply = await get("/lab?cloudru_shim=wrong&x=1", { host: host(), cookie: shimCookie() });
    expect(reply.status).toBe(403);
    expect(reply.headers["set-cookie"]).toBeUndefined();
    expect(seen.length).toBe(before);
  });

  it("forwards a cookie-authenticated request without the credential and rewrites the response", async () => {
    const reply = await get("/lab/tree", { host: host(), cookie: `${shimCookie()}; _xsrf=abc` });
    expect(reply.status).toBe(200);
    expect(reply.body).toBe("ok");
    const forwarded = lastSeen();
    expect(forwarded.url).toBe("/lab/tree");
    expect(forwarded.headers.cookie).toBe("_xsrf=abc");
    expect(forwarded.headers.host).toBe(`127.0.0.1:${podPort}`);
    expect(forwarded.headers.authorization).toBeUndefined();
    expect(reply.headers["x-frame-options"]).toBeUndefined();
    expect(reply.headers["set-cookie"]).toEqual(["_xsrf=abc; Path=/"]);
  });

  it("does not pass another notebook's shim cookie on to the pod", async () => {
    const reply = await get("/lab/tree", { host: host(), cookie: `cloudru_shim_1=other-secret; ${shimCookie()}` });
    expect(reply.status).toBe(200);
    expect(lastSeen().headers.cookie).toBeUndefined();
  });

  it("accepts the Jupyter token header and strips it before forwarding", async () => {
    const reply = await get("/api/kernels", { host: host(), authorization: `token ${token}` });
    expect(reply.status).toBe(200);
    expect(lastSeen().headers.authorization).toBeUndefined();
  });

  it("strips the token parameter, keeps the others, and traces only the clean URL", async () => {
    const reply = await get(`/api/kernels?token=${token}&a=b`, { host: host() });
    expect(reply.status).toBe(200);
    expect(lastSeen().url).toBe("/api/kernels?a=b");
    expect(onTrace).toHaveBeenLastCalledWith("GET", "/api/kernels?a=b", 200);
    expect(JSON.stringify(onTrace.mock.calls)).not.toContain(token);
  });

  it("allows a cross-site browser request only as a navigation", async () => {
    const headers = { host: host(), cookie: shimCookie(), "sec-fetch-site": "cross-site" };
    expect((await get("/lab", { ...headers, "sec-fetch-mode": "cors" })).status).toBe(403);
    expect((await get("/lab", { ...headers, "sec-fetch-mode": "navigate" })).status).toBe(200);
  });

  it("proxies an authenticated WebSocket upgrade without the token", async () => {
    const before = seen.length;
    const ws = await upgrade(`/api/kernels/k1/channels?session_id=s1&token=${token}`, {
      Origin: `http://127.0.0.1:${port}`,
    });
    await vi.waitFor(() => expect(ws.received()).toContain("hello"));
    expect(ws.received()).toMatch(/^HTTP\/1\.1 101 Switching Protocols\r\n[\s\S]*\r\n\r\nhello$/);
    expect(seen.slice(before).map((request) => request.url)).toEqual(["/api/kernels/k1/channels?session_id=s1"]);
    ws.socket.destroy();
  });

  it("refuses a WebSocket upgrade without a credential and closes the socket", async () => {
    const before = seen.length;
    const ws = await upgrade("/api/kernels/k1/channels?session_id=s1", { Origin: `http://127.0.0.1:${port}` });
    await ws.closed;
    expect(ws.received()).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
    expect(seen.length).toBe(before);
  });

  it("refuses a WebSocket upgrade from a foreign Origin even with the token", async () => {
    const before = seen.length;
    const ws = await upgrade(`/api/kernels/k1/channels?token=${token}`, { Origin: "https://evil.test" });
    await ws.closed;
    expect(ws.received()).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
    expect(seen.length).toBe(before);
  });

  it("closes its WebSockets and stops listening on dispose", async () => {
    const other = newShim();
    const otherPort = Number(new URL(await other.start()).port);

    // The secret is per instance: this shim refuses the first shim's token.
    const foreign = await upgrade(`/api/kernels/k2/channels?token=${token}`, {}, otherPort);
    await foreign.closed;
    expect(foreign.received()).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);

    const ws = await upgrade(`/api/kernels/k2/channels?token=${other.token}`, {}, otherPort);
    await vi.waitFor(() => expect(ws.received()).toContain("hello"));
    other.dispose();
    await ws.closed;
    await expect(connect(otherPort)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("answers 502 and closes the WebSocket when the SSH tunnel cannot be opened, without throwing", async () => {
    // What the real agent does once the SSH session is gone: every upstream connect fails. The HTTP
    // path must report 502; the upgrade path has no response object, so http-proxy's error must be
    // routed to onError and end the client socket rather than surface as an uncaught exception.
    const tunnelDown = new Error("SSH connection was closed");
    const agent = new (class extends http.Agent {
      override createConnection(_options: unknown, callback: (err: Error | null, socket?: Duplex) => void): undefined {
        queueMicrotask(() => callback(tunnelDown));
        return undefined;
      }
    })({ keepAlive: false });
    const dead = new NotebookShim({ upstream: `http://127.0.0.1:${podPort}`, agent, onError, onTrace });
    const deadPort = Number(new URL(await dead.start()).port);
    onError.mockClear();
    try {
      const reply = await get("/api/status", { host: `127.0.0.1:${deadPort}`, authorization: `token ${dead.token}` }, deadPort);
      expect(reply.status).toBe(502);
      expect(onError).toHaveBeenCalledWith(tunnelDown);

      onError.mockClear();
      const ws = await upgrade(`/api/kernels/k3/channels?token=${dead.token}`, { Origin: `http://127.0.0.1:${deadPort}` }, deadPort);
      await ws.closed;
      expect(ws.received()).not.toContain("101");
      expect(onError).toHaveBeenCalledWith(tunnelDown);
    } finally {
      dead.dispose();
    }
  });
});
