import { once } from "node:events";
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import { duplexPair, type Duplex } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSshTunnelAgent } from "../../src/jupyter/sshAgent";

let server: http.Server;
let port: number;
const tcpSockets = new Set<net.Socket>();
const agents: http.Agent[] = [];

/** Stands in for `SshConnection.openStream`: a bare Duplex (no socket methods) piped to the server. */
async function openBareStream(): Promise<Duplex> {
  const [client, remote] = duplexPair();
  const tcp = net.connect(port, "127.0.0.1");
  tcpSockets.add(tcp);
  tcp.on("close", () => tcpSockets.delete(tcp));
  remote.pipe(tcp).pipe(remote);
  // duplexPair halves don't propagate destroy (an ssh2 channel is one Duplex), so tie the harness legs together.
  client.once("close", () => tcp.destroy());
  tcp.once("close", () => client.destroy());
  return client;
}

function makeAgent(open: () => Promise<Duplex>): http.Agent {
  const agent = createSshTunnelAgent(open);
  agents.push(agent);
  return agent;
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/slow") return; // never answered
    res.end("ok");
  });
  server.on("upgrade", (_req, socket: Duplex) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (chunk: Buffer) => socket.write(chunk));
    // http.Server accepts sockets with allowHalfOpen, so an upgraded socket outlives the peer's FIN
    // (and server.close() would wait for it forever) unless the handler closes it.
    socket.on("end", () => socket.destroy());
    socket.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(() => {
  for (const agent of agents.splice(0)) agent.destroy();
  for (const tcp of tcpSockets) tcp.destroy();
  server.closeAllConnections();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("createSshTunnelAgent", () => {
  it("carries a plain HTTP request over the opened stream", async () => {
    const open = vi.fn(openBareStream);
    const agent = makeAgent(open);

    const req = http.get({ agent, host: "127.0.0.1", port, path: "/" });
    const [res] = (await once(req, "response")) as [http.IncomingMessage];
    let body = "";
    for await (const chunk of res) body += String(chunk);

    expect(res.statusCode).toBe(200);
    expect(body).toBe("ok");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("hands over an upgraded socket that accepts http-proxy's socket setup and echoes data", async () => {
    const agent = makeAgent(openBareStream);

    const req = http.request({
      agent,
      host: "127.0.0.1",
      port,
      path: "/ws",
      headers: { connection: "Upgrade", upgrade: "websocket" },
    });
    req.end();
    const [, socket] = (await once(req, "upgrade")) as [http.IncomingMessage, net.Socket];
    // The calls http-proxy's setupSocket makes on both legs of a proxied WebSocket.
    socket.setTimeout(0);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 0);
    socket.write("ping");
    const [chunk] = (await once(socket, "data")) as [Buffer];
    socket.destroy();

    expect(chunk.toString("utf8")).toBe("ping");
  });

  it("emits timeout on a request whose upstream stays silent", async () => {
    const agent = makeAgent(openBareStream);

    // Real 50 ms wait: the timer under test is armed by Node's http client on a live stream.
    const req = http.get({ agent, host: "127.0.0.1", port, path: "/slow" });
    req.on("error", () => undefined); // destroy() below surfaces "socket hang up"
    req.setTimeout(50);
    await once(req, "timeout");
    req.destroy();
    // events.once would reject on the "socket hang up" error emitted before "close".
    await new Promise<void>((resolve) => req.once("close", resolve));
  });

  it("fails the request with the error from a rejected open", async () => {
    const failure = new Error("SSH connection was closed");
    const agent = makeAgent(() => Promise.reject(failure));

    const req = http.get({ agent, host: "127.0.0.1", port, path: "/" });
    const [error] = (await once(req, "error")) as [Error];

    expect(error).toBe(failure);
  });
});
