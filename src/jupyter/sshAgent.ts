import * as http from "node:http";
import type { Duplex } from "node:stream";

type SocketMethod = "setNoDelay" | "setKeepAlive" | "ref" | "unref" | "setTimeout";
type MaybeSocket = Duplex & Partial<Record<SocketMethod, unknown>>;

/**
 * `socket.setTimeout` semantics for a plain stream: emit `"timeout"` after `ms` without reads or writes.
 * Node's http client (`req.setTimeout`, http-proxy's `proxyTimeout`) relies on this to abort stalled
 * upstream requests. The `"data"` listener is attached only while a timeout is armed so it never puts
 * the stream into flowing mode before the http client has subscribed.
 */
function inactivityTimeout(stream: Duplex): (ms: number, callback?: () => void) => Duplex {
  let idleMs = 0;
  let timer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    clearTimeout(timer);
    if (idleMs > 0 && !stream.destroyed) {
      timer = setTimeout(() => stream.emit("timeout"), idleMs);
      timer.unref();
    }
  };
  const write = stream.write as (...args: unknown[]) => boolean;
  stream.write = ((...args: unknown[]) => {
    arm();
    return write.apply(stream, args);
  }) as Duplex["write"];
  stream.once("close", () => {
    idleMs = 0;
    stream.removeListener("data", arm);
    arm();
  });
  return (ms, callback) => {
    idleMs = ms;
    stream.removeListener("data", arm);
    if (ms > 0) stream.on("data", arm);
    if (callback) {
      if (ms > 0) stream.once("timeout", callback);
      else stream.removeListener("timeout", callback);
    }
    arm();
    return stream;
  };
}

/** Adds the `net.Socket` methods Node's http client and http-proxy call, without overriding existing ones. */
function toSocketLike(stream: Duplex): Duplex {
  const socket = stream as MaybeSocket;
  for (const name of ["setNoDelay", "setKeepAlive", "ref", "unref"] as const) {
    if (typeof socket[name] !== "function") socket[name] = () => stream;
  }
  if (typeof socket.setTimeout !== "function") socket.setTimeout = inactivityTimeout(stream);
  return stream;
}

/**
 * HTTP agent whose "connections" are ssh2 channels to the pod, so no local TCP listener is ever opened
 * for the upstream side. `keepAlive: false` gives one SSH channel per request, exactly like the old
 * per-connection port forward; channels are cheap and a stale pooled channel would outlive its tunnel.
 */
class SshTunnelAgent extends http.Agent {
  constructor(private readonly open: () => Promise<Duplex>) {
    super({ keepAlive: false });
  }

  /** Async form: returning `undefined` tells `Agent.createSocket` the callback delivers the socket. */
  createConnection(_options: unknown, callback: (err: Error | null, socket?: Duplex) => void): undefined {
    this.open().then(
      (stream) => callback(null, toSocketLike(stream)),
      (err: unknown) => callback(err instanceof Error ? err : new Error(String(err))),
    );
    return undefined;
  }
}

export function createSshTunnelAgent(open: () => Promise<Duplex>): http.Agent {
  return new SshTunnelAgent(open);
}
