import * as http from "node:http";

/**
 * Quick liveness probe for a local shim reached over the SSH tunnel. Used to detect a dead tunnel
 * (e.g. after a pause→resume recreated the pod) before reusing a cached shim, so the kernel picker /
 * webview reconnect instead of hanging forever on a stale proxy.
 *
 * Only 2xx/3xx count as alive: every caller probes a `NotebookShim`, whose 502 means the SSH channel
 * to the pod is gone. `headers` carries the shim credential (`NotebookShim.authHeaders`) — without it
 * the shim answers 403 and the probe reports dead.
 */
export function probeHttpAlive(
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  let settled = false;
  const done = (alive: boolean): void => {
    if (settled) return;
    settled = true;
    resolve(alive);
  };
  const req = http.get(url, { timeout: opts.timeoutMs ?? 3000, headers: opts.headers }, (res) => {
    const status = res.statusCode ?? 0;
    res.resume(); // drain so the socket can be reused/freed
    done(status >= 200 && status < 400);
  });
  req.on("error", () => done(false));
  req.on("timeout", () => {
    req.destroy();
    done(false);
  });
  return promise;
}
