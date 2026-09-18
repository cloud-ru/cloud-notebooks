import { mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  POD_FAST_THRESHOLD_BPS,
  buildInstallScript,
  buildProbeScript,
  buildSpeedProbeScript,
  cliDownloadUrl,
  ensureDownload,
  mapArch,
  parseProbeOutput,
  parseProductJson,
  parseSpeedOutput,
  preseedServer,
  remotePaths,
  serverDownloadUrl,
  type ProductInfo,
} from "../../src/ssh/serverPreseed";

const COMMIT = "6a44c352bd24569c417e530095901b649960f9f8";

const stock: ProductInfo = {
  commit: COMMIT,
  quality: "stable",
  serverDataFolderName: ".vscode-server",
};

describe("parseProductJson", () => {
  it("accepts stock VS Code product.json", () => {
    const product = parseProductJson(
      JSON.stringify({
        commit: COMMIT,
        quality: "stable",
        serverDataFolderName: ".vscode-server",
        updateUrl: "https://update.code.visualstudio.com",
      }),
    );
    expect(product).toMatchObject({ commit: COMMIT, quality: "stable", serverDataFolderName: ".vscode-server" });
  });

  it("defaults quality and data folder when absent", () => {
    const product = parseProductJson(JSON.stringify({ commit: COMMIT }));
    expect(product).toMatchObject({ quality: "stable", serverDataFolderName: ".vscode-server" });
  });

  it("rejects a missing or malformed commit", () => {
    expect(parseProductJson(JSON.stringify({ quality: "stable" }))).toBeUndefined();
    expect(parseProductJson(JSON.stringify({ commit: "abc" }))).toBeUndefined();
    expect(parseProductJson("not json")).toBeUndefined();
  });

  it("rejects a fork with an unknown update endpoint and no download template", () => {
    const fork = parseProductJson(JSON.stringify({ commit: COMMIT, updateUrl: "https://example.com/update" }));
    expect(fork).toBeUndefined();
  });

  it("accepts a fork that provides its own server download template", () => {
    const fork = parseProductJson(
      JSON.stringify({
        commit: COMMIT,
        updateUrl: "https://example.com/update",
        serverDownloadUrlTemplate: "https://example.com/${commit}/server-${os}-${arch}/${quality}",
        serverDataFolderName: ".fork-server",
      }),
    );
    expect(fork?.serverDataFolderName).toBe(".fork-server");
  });
});

describe("download urls", () => {
  it("builds the stock server url from commit, arch and quality", () => {
    expect(serverDownloadUrl(stock, "x64")).toBe(
      `https://update.code.visualstudio.com/commit:${COMMIT}/server-linux-x64/stable`,
    );
  });

  it("substitutes all template variables when a template is present", () => {
    const fork: ProductInfo = {
      ...stock,
      serverDownloadUrlTemplate: "https://dl.example.com/${quality}/${commit}/${os}-${arch}.tar.gz",
    };
    expect(serverDownloadUrl(fork, "arm64")).toBe(`https://dl.example.com/stable/${COMMIT}/linux-arm64.tar.gz`);
  });

  it("knows the CLI url only for the stock endpoint", () => {
    expect(cliDownloadUrl(stock, "x64")).toBe(
      `https://update.code.visualstudio.com/commit:${COMMIT}/cli-alpine-x64/stable`,
    );
    expect(cliDownloadUrl({ ...stock, updateUrl: "https://example.com" }, "x64")).toBeUndefined();
  });
});

describe("mapArch", () => {
  it("maps uname -m to download arch tokens", () => {
    expect(mapArch("x86_64\n")).toBe("x64");
    expect(mapArch("aarch64")).toBe("arm64");
    expect(mapArch("riscv64")).toBeUndefined();
  });
});

describe("remotePaths", () => {
  it("uses the exec-server layout observed in Remote-SSH logs", () => {
    const paths = remotePaths(stock);
    expect(paths.serverDir).toBe(`.vscode-server/cli/servers/Stable-${COMMIT}/server`);
    expect(paths.legacyBinDir).toBe(`.vscode-server/bin/${COMMIT}`);
    expect(paths.cliBin).toBe(`.vscode-server/code-${COMMIT}`);
  });

  it("maps insider quality to the Insiders dir prefix", () => {
    const paths = remotePaths({ ...stock, quality: "insider" });
    expect(paths.serverParentDir).toBe(`.vscode-server/cli/servers/Insiders-${COMMIT}`);
  });
});

describe("probe", () => {
  it("round-trips through the probe script contract", () => {
    const script = buildProbeScript(remotePaths(stock));
    expect(script).toContain(`"$HOME/.vscode-server/cli/servers/Stable-${COMMIT}/server/node"`);
    const parsed = parseProbeOutput("home=/home/jovyan\narch=x86_64\nserver=present\ncli=absent\n");
    expect(parsed).toEqual({ home: "/home/jovyan", arch: "x64", serverPresent: true, cliPresent: false });
  });

  it("returns undefined for garbage or unsupported arch", () => {
    expect(parseProbeOutput("motd banner\n")).toBeUndefined();
    expect(parseProbeOutput("home=/home/jovyan\narch=riscv64\n")).toBeUndefined();
  });

  it("tolerates extra login-shell noise around the key=value lines", () => {
    const parsed = parseProbeOutput("Welcome!\nhome=/home/jovyan\narch=aarch64\nserver=absent\ncli=absent\nbye\n");
    expect(parsed?.arch).toBe("arm64");
    expect(parsed?.serverPresent).toBe(false);
  });
});

describe("buildInstallScript", () => {
  const paths = remotePaths(stock);

  it("extracts to a temp dir and moves into place atomically", () => {
    const script = buildInstallScript(paths, { serverTar: "/tmp/s.tar.gz", cliTar: "/tmp/c.tar.gz" });
    expect(script).toContain("set -e");
    expect(script).toContain('tar -xzf "/tmp/s.tar.gz" --strip-components=1 -C "$T"');
    expect(script).toContain('[ -e "$P/server" ] || mv "$T" "$P/server"');
    expect(script).toContain(`ln -sn "$P/server" "$HOME/.vscode-server/bin/${COMMIT}"`);
    expect(script).toContain('rm -f "/tmp/s.tar.gz" "/tmp/c.tar.gz"');
  });

  it("omits server extraction when only the CLI is needed", () => {
    const script = buildInstallScript(paths, { cliTar: "/tmp/c.tar.gz" });
    expect(script).not.toContain("--strip-components");
    expect(script).not.toContain("/dev/null");
    expect(script).toContain('tar -xzf "/tmp/c.tar.gz"');
    expect(script).toContain('rm -f "/tmp/c.tar.gz"');
  });

  it("guards the legacy symlink on the server dir actually existing", () => {
    const script = buildInstallScript(paths, { cliTar: "/tmp/c.tar.gz" });
    expect(script).toContain('if [ -e "$P/server" ] && [ ! -e');
  });
});

describe("speed probe", () => {
  it("samples a 2 MiB range through curl with a hard time cap", () => {
    const script = buildSpeedProbeScript("https://example.com/tar");
    expect(script).toContain("-r 0-2097151");
    expect(script).toContain("-m 6");
    expect(script).toContain("'https://example.com/tar'");
    expect(script).toContain("speed=unknown");
  });

  it("parses curl speed output and rejects unknown/zero/garbage", () => {
    expect(parseSpeedOutput("speed=2456789.000\n")).toBeCloseTo(2456789);
    expect(parseSpeedOutput("speed=0\n")).toBeUndefined();
    expect(parseSpeedOutput("speed=unknown\n")).toBeUndefined();
    expect(parseSpeedOutput("motd\n")).toBeUndefined();
  });
});

const tmpDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "preseed-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const silentLog = { info: () => undefined, warn: () => undefined };

/** Fake exec speaking the probe/speed/install script protocol. */
function fakeExec(opts: { serverPresent?: boolean; cliPresent?: boolean; podSpeed?: number | "unknown" }) {
  const calls: string[] = [];
  const installDeadlines: (number | undefined)[] = [];
  const exec = async (_cmd: string, stdin?: string, _signal?: AbortSignal, deadlineMs?: number) => {
    calls.push(stdin ?? "");
    if (stdin?.includes("uname -m")) {
      return {
        code: 0,
        stdout: [
          "home=/home/jovyan",
          "arch=x86_64",
          `server=${opts.serverPresent ? "present" : "absent"}`,
          `cli=${opts.cliPresent ? "present" : "absent"}`,
          "",
        ].join("\n"),
        stderr: "",
      };
    }
    if (stdin?.includes("speed_download")) {
      return { code: 0, stdout: `speed=${opts.podSpeed ?? "unknown"}\n`, stderr: "" };
    }
    installDeadlines.push(deadlineMs); // install script
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls, installDeadlines };
}

describe("preseedServer decisions", () => {
  const product: ProductInfo = { commit: COMMIT, quality: "stable", serverDataFolderName: ".vscode-server" };
  const noSftp = () => Promise.reject(new Error("sftp must not be used"));
  const noFetch: typeof fetch = () => Promise.reject(new Error("fetch must not be used"));

  it("skips pre-seeding when the pod's own egress is fast", async () => {
    const { exec } = fakeExec({ podSpeed: POD_FAST_THRESHOLD_BPS * 2 });
    const result = await preseedServer({
      product,
      exec,
      sftp: noSftp,
      cacheDir: tempDir(),
      fetchImpl: noFetch,
      log: silentLog,
    });
    expect(result.status).toBe("skipped");
    expect(result.status === "skipped" && result.reason).toContain("fast");
  });

  it("short-circuits to already when server and cli are present, without any network", async () => {
    const { exec, calls } = fakeExec({ serverPresent: true, cliPresent: true });
    const result = await preseedServer({
      product,
      exec,
      sftp: noSftp,
      cacheDir: tempDir(),
      fetchImpl: noFetch,
      log: silentLog,
    });
    expect(result).toEqual({ status: "already" });
    expect(calls).toHaveLength(1);
  });

  it("proceeds with pre-seed when the pod has no curl (speed unknown)", async () => {
    const { exec, calls } = fakeExec({ podSpeed: "unknown" });
    // Fetch fails fast → preseed throws, but only AFTER deciding to download (speed did not skip).
    await expect(
      preseedServer({ product, exec, sftp: noSftp, cacheDir: tempDir(), fetchImpl: noFetch, log: silentLog }),
    ).rejects.toThrow("fetch must not be used");

    expect(calls.some((script) => script.includes("speed_download"))).toBe(true);
  });
  it("seeds through upload and gives the install unpack a long deadline", async () => {
    const { exec, installDeadlines } = fakeExec({ podSpeed: 1000, cliPresent: true });
    const sftp = {
      fastPut: (...args: unknown[]) => (args[args.length - 1] as (err?: unknown) => void)(null),
      end: () => undefined,
    };
    const result = await preseedServer({
      product,
      exec,
      sftp: async () => sftp as never,
      cacheDir: tempDir(),
      fetchImpl: rangedFetch(makePayload(1024 * 1024)),
      log: silentLog,
    });
    expect(result).toEqual({ status: "seeded", cliSeeded: false });
    expect(installDeadlines).toEqual([600_000]);
  });

  it("passes cancellation to a stalled probe", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const running = preseedServer({
      product,
      exec: (_command, _stdin, signal) => new Promise((_resolve, reject) => {
        started.resolve();
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }),
      sftp: noSftp,
      cacheDir: tempDir(),
      fetchImpl: noFetch,
      signal: controller.signal,
      log: silentLog,
    });
    await started.promise;
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  it("ends a stalled SFTP upload as soon as the user cancels", async () => {
    const cacheDir = tempDir();
    fs.writeFileSync(path.join(cacheDir, `server-${COMMIT}-linux-x64.tar.gz`), "cached");
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    let ended = false;
    const sftp = {
      fastPut: () => { started.resolve(); },
      end: () => { ended = true; },
    };
    const { exec } = fakeExec({ cliPresent: true });
    const running = preseedServer({
      product,
      exec,
      sftp: async () => sftp as never,
      cacheDir,
      signal: controller.signal,
      log: silentLog,
    });
    await started.promise;
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(ended).toBe(true);
  });
});

/** Serve `body` honoring single-range requests, like a CDN. */
function rangedFetch(body: Buffer, log?: string[]): typeof fetch {
  return async (_url, init) => {
    const headers = new Headers(init?.headers);
    const range = headers.get("range");
    log?.push(range ?? "full");
    if (!range) return new Response(new Uint8Array(body), { status: 200, headers: { "content-length": String(body.length) } });
    const match = range.match(/bytes=(\d+)-(\d+)/);
    if (!match) throw new Error(`bad range: ${range}`);
    const from = Number(match[1]);
    const to = Math.min(Number(match[2]), body.length - 1);
    const slice = body.subarray(from, to + 1);
    return new Response(new Uint8Array(slice), {
      status: 206,
      headers: { "content-range": `bytes ${from}-${to}/${body.length}`, "content-length": String(slice.length) },
    });
  };
}

/** Deterministic pseudo-random payload large enough to span multiple 8 MiB chunks. */
function makePayload(bytes: number): Buffer {
  const buf = Buffer.allocUnsafe(bytes);
  let state = 0x12345678;
  for (let i = 0; i < bytes; i += 4) {
    state = (state * 1664525 + 1013904223) >>> 0;
    buf.writeUInt32LE(state, Math.min(i, bytes - 4));
  }
  return buf;
}

describe("chunked download", () => {
  it("downloads via parallel ranges and assembles the exact payload", async () => {
    const payload = makePayload(20 * 1024 * 1024); // 3 chunks of 8 MiB
    const ranges: string[] = [];
    const dest = path.join(tempDir(), "server.tar.gz");
    const handle = ensureDownload("https://cdn.example/tar", dest, rangedFetch(payload, ranges));
    await handle.promise;
    expect(fs.readFileSync(dest).equals(payload)).toBe(true);
    expect(ranges.length).toBe(3);
    expect(fs.readdirSync(path.dirname(dest))).toEqual(["server.tar.gz"]); // parts and meta cleaned up
  });

  it("resumes: complete parts are not re-requested", async () => {
    const payload = makePayload(20 * 1024 * 1024);
    const dest = path.join(tempDir(), "server.tar.gz");
    // Simulate a previous aborted attempt: chunk 1 fully downloaded + meta sidecar present.
    fs.writeFileSync(`${dest}.meta.json`, JSON.stringify({ total: payload.length }));
    fs.writeFileSync(`${dest}.part-1`, payload.subarray(8 * 1024 * 1024, 16 * 1024 * 1024));
    const ranges: string[] = [];
    await ensureDownload("https://cdn.example/tar", dest, rangedFetch(payload, ranges)).promise;
    expect(fs.readFileSync(dest).equals(payload)).toBe(true);
    expect(ranges).toHaveLength(2); // chunks 0 and 2 only
    expect(ranges.some((r) => r.startsWith("bytes=8388608-"))).toBe(false);
  });

  it("falls back to a single stream when the server ignores ranges", async () => {
    const payload = makePayload(1024 * 1024);
    const plainFetch: typeof fetch = async () =>
      new Response(new Uint8Array(payload), { status: 200, headers: { "content-length": String(payload.length) } });
    const dest = path.join(tempDir(), "cli.tar.gz");
    await ensureDownload("https://cdn.example/cli", dest, plainFetch).promise;
    expect(fs.readFileSync(dest).equals(payload)).toBe(true);
  });

  it("reuses an existing cached file without touching the network", async () => {
    const dest = path.join(tempDir(), "server.tar.gz");
    fs.writeFileSync(dest, "cached");
    const noFetch: typeof fetch = () => Promise.reject(new Error("must not fetch"));
    await expect(ensureDownload("https://cdn.example/tar", dest, noFetch).promise).resolves.toBeUndefined();
  });

  it("dedupes concurrent downloads of the same destination", async () => {
    const payload = makePayload(1024 * 1024);
    let fetches = 0;
    const countingFetch: typeof fetch = async (url, init) => {
      fetches += 1;
      return rangedFetch(payload)(url, init);
    };
    const dest = path.join(tempDir(), "server.tar.gz");
    const a = ensureDownload("https://cdn.example/tar", dest, countingFetch);
    const b = ensureDownload("https://cdn.example/tar", dest, countingFetch);
    expect(b).toBe(a);
    await Promise.all([a.promise, b.promise]);
    expect(fetches).toBe(1);
  });
});

describe("slow download deferral", () => {
  const product: ProductInfo = { commit: COMMIT, quality: "stable", serverDataFolderName: ".vscode-server" };

  it("detaches a slow download to the background and returns deferred", async () => {
    const cacheDir = tempDir();
    const dest = path.join(cacheDir, `server-${COMMIT}-linux-x64.tar.gz`);
    try {
      // A stream that yields one small chunk and then stalls forever (no content-length → rate path).
      const stalledFetch: typeof fetch = async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(1024));
              // never close
            },
          }),
          { status: 200 },
        );
      const { exec } = fakeExec({ podSpeed: 1000 }); // pod is slow too → preseed engages
      // tickMs=1 + graceMs=0: the watchdog judges immediately; we await the real result promise,
      // no wall-clock sleeps involved.
      const result = await preseedServer({
        product,
        exec,
        sftp: () => Promise.reject(new Error("sftp must not be used")),
        cacheDir,
        fetchImpl: stalledFetch,
        log: silentLog,
        deferPolicy: { graceMs: 0, maxEtaMs: 1, minRateBps: Number.MAX_SAFE_INTEGER, tickMs: 1 },
      });
      expect(result).toEqual({ status: "deferred" });
    } finally {
      // The transfer intentionally keeps running in the background; stop it before cleanup.
      const job = ensureDownload("irrelevant", dest, fetch);
      job.cancel();
      await job.promise.catch(() => undefined);
    }
  });
});
