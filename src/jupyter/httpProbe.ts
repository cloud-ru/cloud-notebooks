import * as http from "node:http";

/**
 * Quick liveness probe for a local URL reached over the SSH tunnel. Used to detect a dead tunnel/shim
 * (e.g. after a pause→resume recreated the pod) before reusing a cached forward or shim, so the kernel
 * picker / webview reconnect instead of hanging forever on a stale port (H9/H10).
 *
 * `acceptAny` treats *any* HTTP response as alive (the tunnel forwarded a byte) — right for the raw
 * pod tunnel. Without it, only 2xx/3xx count as alive — right for the shim, whose 502 means the
 * upstream tunnel is gone.
 */
export function probeHttpAlive(
  url: string,
  opts: { acceptAny?: boolean; timeoutMs?: number } = {},
): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  let settled = false;
  const done = (alive: boolean): void => {
    if (settled) return;
    settled = true;
    resolve(alive);
  };
  const req = http.get(url, { timeout: opts.timeoutMs ?? 3000 }, (res) => {
    const status = res.statusCode ?? 0;
    res.resume(); // drain so the socket can be reused/freed
    done(opts.acceptAny ? status > 0 : status >= 200 && status < 400);
  });
  req.on("error", () => done(false));
  req.on("timeout", () => {
    req.destroy();
    done(false);
  });
  return promise;
}
