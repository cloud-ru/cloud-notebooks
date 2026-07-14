// Pre-seeds the VS Code Server onto a pod before handing off to Remote-SSH.
//
// Why: some pods have throttled egress to update.code.visualstudio.com (~0.5 MB/s), so Remote-SSH's
// own on-pod download of the ~150 MB server tarball takes many minutes and looks like an infinite
// "Setting up SSH host". The pre-seed path downloads the tarball on the user's side (parallel range
// requests, chunk-resumable cache per commit) and uploads it over SFTP through the fast gateway.
//
// The stage disables itself whenever it would not help:
//   - the pod already has the matching server → instant no-op;
//   - a 2 MB curl sample shows the pod's own egress is fast → skip, Remote-SSH installs on the pod;
//   - the local download is slow (ETA over ~1 min) → it detaches to the background to fill the
//     cache for the next connect, and the Remote-SSH window opens immediately.
//
// If anything here fails, the caller proceeds anyway and Remote-SSH falls back to its own installer.
//
// No `vscode` import → unit-testable (Р7). All effects are injected via `PreseedDeps`.

import * as fs from "node:fs";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { SFTPWrapper } from "ssh2";
import type { ExecResult } from "./connection";

const UPDATE_URL = "https://update.code.visualstudio.com";
const COMMIT_RE = /^[0-9a-f]{40}$/;

/** Pod egress at or above this → skip pre-seeding, the pod installs faster on its own. */
export const POD_FAST_THRESHOLD_BPS = 2 * 1024 * 1024;

/** When the local download looks slower than this policy, it detaches to the background. */
export interface DeferPolicy {
  /** Measure at least this long before judging. */
  graceMs: number;
  /** Defer when the estimated time to finish exceeds this. */
  maxEtaMs: number;
  /** Defer when the total size is unknown and the rate is below this. */
  minRateBps: number;
  /** Watchdog evaluation period. */
  tickMs: number;
}

export const DEFAULT_DEFER_POLICY: DeferPolicy = {
  graceMs: 12_000,
  maxEtaMs: 60_000,
  minRateBps: 1024 * 1024,
  tickMs: 500,
};

const CHUNK_SIZE = 8 * 1024 * 1024;
const CHUNK_CONCURRENCY = 6;

/** The slice of the client's `product.json` needed to locate and fetch a matching server build. */
export interface ProductInfo {
  commit: string;
  quality: string;
  /** Remote data dir under `$HOME`, e.g. `.vscode-server` (forks override it, e.g. `.cursor-server`). */
  serverDataFolderName: string;
  /** Fork-specific server tarball URL template (`${commit}`/`${os}`/`${arch}`/`${quality}`). */
  serverDownloadUrlTemplate?: string | undefined;
  /** Update endpoint; the standalone CLI tarball is only known for the stock MS endpoint. */
  updateUrl?: string | undefined;
}

/** Parse `product.json` text into the fields we need. `undefined` → this client can't be pre-seeded. */
export function parseProductJson(text: string): ProductInfo | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const commit = typeof raw.commit === "string" ? raw.commit : "";
  if (!COMMIT_RE.test(commit)) return undefined;
  const quality = typeof raw.quality === "string" && raw.quality ? raw.quality : "stable";
  const serverDataFolderName =
    typeof raw.serverDataFolderName === "string" && raw.serverDataFolderName
      ? raw.serverDataFolderName
      : ".vscode-server";
  const serverDownloadUrlTemplate =
    typeof raw.serverDownloadUrlTemplate === "string" ? raw.serverDownloadUrlTemplate : undefined;
  const updateUrl = typeof raw.updateUrl === "string" ? raw.updateUrl : undefined;
  // Without a download template we only know the stock Microsoft endpoint; skip unknown forks.
  if (!serverDownloadUrlTemplate && updateUrl !== undefined && !updateUrl.startsWith(UPDATE_URL)) {
    return undefined;
  }
  return { commit, quality, serverDataFolderName, serverDownloadUrlTemplate, updateUrl };
}

/** Map `uname -m` output to the download-arch token. `undefined` → unsupported pod arch. */
export function mapArch(unameM: string): "x64" | "arm64" | undefined {
  switch (unameM.trim()) {
    case "x86_64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return undefined;
  }
}

/** Server tarball URL: the product's template when present, else the stock update endpoint. */
export function serverDownloadUrl(product: ProductInfo, arch: string): string {
  if (product.serverDownloadUrlTemplate) {
    return product.serverDownloadUrlTemplate
      .replaceAll("${commit}", product.commit)
      .replaceAll("${os}", "linux")
      .replaceAll("${arch}", arch)
      .replaceAll("${quality}", product.quality);
  }
  return `${UPDATE_URL}/commit:${product.commit}/server-linux-${arch}/${product.quality}`;
}

/** Standalone CLI tarball URL (static musl build), known only for the stock MS endpoint. */
export function cliDownloadUrl(product: ProductInfo, arch: string): string | undefined {
  const stock = product.updateUrl === undefined || product.updateUrl.startsWith(UPDATE_URL);
  if (!stock) return undefined;
  return `${UPDATE_URL}/commit:${product.commit}/cli-alpine-${arch}/${product.quality}`;
}

/** Directory prefix the VS Code CLI uses under `cli/servers/` for a given quality. */
function qualityDirPrefix(quality: string): string {
  switch (quality) {
    case "stable":
      return "Stable";
    case "insider":
      return "Insiders";
    case "exploration":
      return "Exploration";
    default:
      return quality.charAt(0).toUpperCase() + quality.slice(1);
  }
}

/** Remote paths (relative to `$HOME`) for both server layouts plus the standalone CLI binary. */
export interface RemotePaths {
  /** Exec-server layout: `<data>/cli/servers/<Quality>-<commit>` (its `server/` child holds the build). */
  serverParentDir: string;
  /** Unpacked server: `<serverParentDir>/server` — what the CLI probes before downloading. */
  serverDir: string;
  /** Classic layout (`useExecServer: false`): `<data>/bin/<commit>`, symlinked to `serverDir`. */
  legacyBinDir: string;
  /** Standalone CLI binary: `<data>/code-<commit>`. */
  cliBin: string;
}

export function remotePaths(product: ProductInfo): RemotePaths {
  const data = product.serverDataFolderName;
  const parent = `${data}/cli/servers/${qualityDirPrefix(product.quality)}-${product.commit}`;
  return {
    serverParentDir: parent,
    serverDir: `${parent}/server`,
    legacyBinDir: `${data}/bin/${product.commit}`,
    cliBin: `${data}/code-${product.commit}`,
  };
}

/** What the probe learned about the pod before any transfer. */
export interface ProbeResult {
  home: string;
  arch: "x64" | "arm64";
  serverPresent: boolean;
  cliPresent: boolean;
}

/** Script for `sh -s` printing `key=value` lines; paths are `$HOME`-relative and double-quoted. */
export function buildProbeScript(paths: RemotePaths): string {
  return [
    `printf 'home=%s\\n' "$HOME"`,
    `printf 'arch=%s\\n' "$(uname -m)"`,
    `if [ -x "$HOME/${paths.serverDir}/node" ]; then printf 'server=present\\n'; else printf 'server=absent\\n'; fi`,
    `if [ -x "$HOME/${paths.cliBin}" ]; then printf 'cli=present\\n'; else printf 'cli=absent\\n'; fi`,
    "",
  ].join("\n");
}

export function parseProbeOutput(stdout: string): ProbeResult | undefined {
  const values = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) values.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  const home = values.get("home");
  const arch = mapArch(values.get("arch") ?? "");
  if (!home || !arch) return undefined;
  return {
    home,
    arch,
    serverPresent: values.get("server") === "present",
    cliPresent: values.get("cli") === "present",
  };
}

/**
 * Script for `sh -s` measuring the pod's own egress to the server tarball: a 2 MiB ranged `curl`
 * capped at 6 s, printing `speed=<bytes per second>`. Prints `speed=unknown` without curl.
 */
export function buildSpeedProbeScript(url: string): string {
  return [
    `if command -v curl >/dev/null 2>&1; then`,
    `  printf 'speed=%s\\n' "$(curl -sf -m 6 -r 0-2097151 -o /dev/null -w '%{speed_download}' '${url}' || printf 0)"`,
    `else`,
    `  printf 'speed=unknown\\n'`,
    `fi`,
    "",
  ].join("\n");
}

/** Bytes/s from the speed probe; `undefined` when curl is missing, failed, or output is garbage. */
export function parseSpeedOutput(stdout: string): number | undefined {
  const match = stdout.match(/^speed=([0-9][0-9.]*)\s*$/m);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Script for `sh -s` that unpacks the uploaded tarballs into place. Extraction goes into a
 * `$$`-suffixed temp dir with an atomic `mv` into the final name, so a concurrent Remote-SSH
 * connect never sees a half-written server; if the final name appeared meanwhile, ours is discarded.
 */
export function buildInstallScript(
  paths: RemotePaths,
  remote: { serverTar?: string | undefined; cliTar?: string | undefined },
): string {
  const lines = ["set -e", `P="$HOME/${paths.serverParentDir}"`, `mkdir -p "$P"`];
  if (remote.serverTar) {
    lines.push(
      `T="$P/.preseed-$$"`,
      `mkdir -p "$T"`,
      `tar -xzf "${remote.serverTar}" --strip-components=1 -C "$T"`,
      `[ -e "$P/server" ] || mv "$T" "$P/server"`,
      `rm -rf "$T"`,
    );
  }
  lines.push(
    `mkdir -p "$(dirname "$HOME/${paths.legacyBinDir}")"`,
    `if [ -e "$P/server" ] && [ ! -e "$HOME/${paths.legacyBinDir}" ]; then ln -sn "$P/server" "$HOME/${paths.legacyBinDir}"; fi`,
  );
  if (remote.cliTar) {
    lines.push(
      `CT="$P/.preseed-cli-$$"`,
      `mkdir -p "$CT"`,
      `tar -xzf "${remote.cliTar}" -C "$CT"`,
      `B="$(find "$CT" -maxdepth 1 -type f | head -n 1)"`,
      `if [ -n "$B" ] && [ ! -e "$HOME/${paths.cliBin}" ]; then chmod +x "$B" && mv "$B" "$HOME/${paths.cliBin}"; fi`,
      `rm -rf "$CT"`,
    );
  }
  const tars = [remote.serverTar, remote.cliTar].filter((t): t is string => t !== undefined);
  if (tars.length > 0) lines.push(`rm -f ${tars.map((t) => `"${t}"`).join(" ")}`);
  lines.push("");
  return lines.join("\n");
}

export type PreseedResult =
  | { status: "already" }
  | { status: "seeded"; cliSeeded: boolean }
  | { status: "skipped"; reason: string }
  /** The local download was too slow to wait for; it continues in the background to fill the cache. */
  | { status: "deferred" };

export interface PreseedDeps {
  product: ProductInfo;
  /** Runs a remote command (script via `sh -s` stdin). */
  exec: (command: string, stdin?: string) => Promise<ExecResult>;
  sftp: () => Promise<SFTPWrapper>;
  /** Local per-commit tarball cache dir (globalStorage). */
  cacheDir: string;
  fetchImpl?: typeof fetch;
  /** Progress callback: human message + absolute percent [0..100]. */
  report?: (message: string, percent: number) => void;
  signal?: AbortSignal;
  deferPolicy?: DeferPolicy | undefined;
  log: { info: (message: string) => void; warn: (message: string) => void };
}

/** Ensure the pod has the server build matching the local client. Throws on transfer/unpack errors. */
export async function preseedServer(deps: PreseedDeps): Promise<PreseedResult> {
  const { product, log } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const report = deps.report ?? (() => undefined);
  const policy = deps.deferPolicy ?? DEFAULT_DEFER_POLICY;
  const paths = remotePaths(product);

  report("проверка сервера на ноутбуке…", 0);
  const probeRun = await deps.exec("sh -s", buildProbeScript(paths));
  if (probeRun.code !== 0) {
    return { status: "skipped", reason: `probe exited with ${probeRun.code}: ${probeRun.stderr.trim()}` };
  }
  const probe = parseProbeOutput(probeRun.stdout);
  if (!probe) return { status: "skipped", reason: `unrecognized probe output: ${probeRun.stdout.trim()}` };
  if (probe.serverPresent && probe.cliPresent) return { status: "already" };
  throwIfAborted(deps.signal);

  // The server tarball is the mandatory piece; the CLI (~15 MB) rides along when we know its URL.
  const serverUrl = serverDownloadUrl(product, probe.arch);
  const cliUrl = probe.cliPresent ? undefined : cliDownloadUrl(product, probe.arch);
  const serverLocal = path.join(deps.cacheDir, `server-${product.commit}-linux-${probe.arch}.tar.gz`);
  const cliLocal = cliUrl ? path.join(deps.cacheDir, `cli-${product.commit}-alpine-${probe.arch}.tar.gz`) : undefined;

  if (!probe.serverPresent && !(await fileExists(serverLocal))) {
    // No cached tarball yet: if the pod's own egress is fast, pre-seeding only adds latency —
    // let Remote-SSH install on the pod (that also persists in the home volume for next time).
    report("оценка скорости сети ноутбука…", 2);
    const speedRun = await deps.exec("sh -s", buildSpeedProbeScript(serverUrl));
    const podBps = speedRun.code === 0 ? parseSpeedOutput(speedRun.stdout) : undefined;
    if (podBps !== undefined && podBps >= POD_FAST_THRESHOLD_BPS) {
      return { status: "skipped", reason: `pod egress is fast (${formatMb(podBps)} MB/s), Remote-SSH installs directly` };
    }
    throwIfAborted(deps.signal);
  }

  if (!probe.serverPresent) {
    const outcome = await downloadWithDeferral(
      serverUrl,
      serverLocal,
      fetchImpl,
      policy,
      deps.signal,
      (done, total) =>
        report(`загрузка сервера ${formatMb(done)}${total ? ` из ${formatMb(total)}` : ""} МБ…`, scale(done, total, 5, 40)),
    );
    if (outcome === "deferred") {
      log.info("[preseed] slow download detached to background; the cache will be ready for a later connect");
      return { status: "deferred" };
    }
  }

  let cliReady = false;
  if (cliUrl && cliLocal) {
    // The CLI is optional: when even ~15 MB is slow, proceed without it and let the cache fill up.
    const outcome = await downloadWithDeferral(cliUrl, cliLocal, fetchImpl, policy, deps.signal, () => undefined);
    cliReady = outcome === "done";
    if (!cliReady && probe.serverPresent) return { status: "deferred" };
  }
  throwIfAborted(deps.signal);

  const remoteServerTar = `/tmp/.cloudru-preseed-${product.commit}-server.tar.gz`;
  const remoteCliTar = cliReady && cliLocal ? `/tmp/.cloudru-preseed-${product.commit}-cli.tar.gz` : undefined;
  const sftp = await deps.sftp();
  if (!probe.serverPresent) {
    await upload(sftp, serverLocal, remoteServerTar, deps.signal, (done, total) =>
      report(`передача на ноутбук ${formatMb(done)} из ${formatMb(total)} МБ…`, scale(done, total, 45, 95)),
    );
  }
  if (cliLocal && remoteCliTar) {
    await upload(sftp, cliLocal, remoteCliTar, deps.signal, () => undefined);
  }
  throwIfAborted(deps.signal);

  report("распаковка сервера…", 96);
  const install = await deps.exec(
    "sh -s",
    buildInstallScript(paths, {
      // A server that is already present only needs the CLI drop; skip re-uploading/unpacking it.
      serverTar: probe.serverPresent ? undefined : remoteServerTar,
      cliTar: remoteCliTar,
    }),
  );
  if (install.code !== 0) {
    throw new Error(`install script exited with ${install.code}: ${install.stderr.trim()}`);
  }
  report("готово", 100);
  log.info(
    `[preseed] seeded ${product.quality}-${product.commit} into ~/${paths.serverDir}` +
      (remoteCliTar ? " (+cli)" : ""),
  );
  return { status: "seeded", cliSeeded: remoteCliTar !== undefined };
}

// ---------------------------------------------------------------------------------------------
// Downloads: parallel ranged chunks with a chunk-granular resumable cache and background deferral.

export interface DownloadProgress {
  done: number;
  total: number | undefined;
}

export interface DownloadHandle {
  promise: Promise<void>;
  /** Abort the underlying transfer (chunk files stay on disk for a later resume). */
  cancel: () => void;
  progress: DownloadProgress;
  /** Attach a progress listener; returns the detach function. */
  subscribe: (listener: (done: number, total: number | undefined) => void) => () => void;
}

interface DownloadJob extends DownloadHandle {
  listeners: Set<(done: number, total: number | undefined) => void>;
}

const inflightDownloads = new Map<string, DownloadJob>();

/**
 * Start (or join) the download of `url` into `dest`. Deduplicated per `dest`, so a deferred
 * background download and a subsequent foreground connect share one transfer.
 */
export function ensureDownload(url: string, dest: string, fetchImpl: typeof fetch): DownloadHandle {
  const existing = inflightDownloads.get(dest);
  if (existing) return existing;

  const controller = new AbortController();
  const listeners = new Set<(done: number, total: number | undefined) => void>();
  const progress: DownloadProgress = { done: 0, total: undefined };
  const notify = (done: number, total: number | undefined): void => {
    progress.done = done;
    progress.total = total;
    for (const listener of listeners) listener(done, total);
  };
  const promise = downloadToFile(url, dest, fetchImpl, controller.signal, notify).finally(() =>
    inflightDownloads.delete(dest),
  );
  // A deferred (detached) download has no awaiter; keep its rejection from being "unhandled".
  promise.catch(() => undefined);

  const job: DownloadJob = {
    promise,
    cancel: () => controller.abort(),
    progress,
    listeners,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  inflightDownloads.set(dest, job);
  return job;
}

/**
 * Await a download, but give up waiting (not downloading) when it is clearly too slow to block a
 * connect on: past `policy.graceMs`, defer when the ETA exceeds `policy.maxEtaMs` (or, without a
 * known total, when the rate is below `policy.minRateBps`). A user abort cancels the transfer.
 */
async function downloadWithDeferral(
  url: string,
  dest: string,
  fetchImpl: typeof fetch,
  policy: DeferPolicy,
  signal: AbortSignal | undefined,
  onProgress: (done: number, total: number | undefined) => void,
): Promise<"done" | "deferred"> {
  const job = ensureDownload(url, dest, fetchImpl);
  const unsubscribe = job.subscribe(onProgress);
  const start = Date.now();
  const { promise, resolve, reject } = Promise.withResolvers<"done" | "deferred">();
  const timer = setInterval(() => {
    if (signal?.aborted) {
      job.cancel();
      return; // job.promise rejects with AbortError and settles the race below.
    }
    const elapsed = Date.now() - start;
    if (elapsed < policy.graceMs) return;
    const { done, total } = job.progress;
    const rate = elapsed > 0 ? (done / elapsed) * 1000 : Number.POSITIVE_INFINITY;
    const slow =
      total !== undefined
        ? ((total - done) / Math.max(rate, 1)) * 1000 > policy.maxEtaMs
        : rate < policy.minRateBps;
    if (slow) resolve("deferred");
  }, policy.tickMs);
  job.promise.then(
    () => resolve("done"),
    (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))),
  );
  try {
    return await promise;
  } finally {
    clearInterval(timer);
    unsubscribe();
  }
}

/**
 * Download `url` into `dest`. When the server honors range requests, transfer runs as
 * `CHUNK_CONCURRENCY` parallel ranged streams into `dest.part-N` files (CDNs throttle per
 * connection, so parallel ranges multiply throughput); completed parts survive aborts and are
 * skipped on the next attempt. Falls back to a single stream when ranges are not supported.
 */
async function downloadToFile(
  url: string,
  dest: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  onProgress: (done: number, total: number | undefined) => void,
): Promise<void> {
  if (await fileExists(dest)) {
    onProgress(0, undefined);
    return;
  }
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });

  // A previous attempt already learned the total → resume the chunked transfer without re-probing.
  const knownTotal = await readMeta(dest);
  if (knownTotal !== undefined) {
    return chunkedDownload(url, dest, knownTotal, undefined, fetchImpl, signal, onProgress);
  }

  const first = await fetchImpl(url, { headers: { Range: `bytes=0-${CHUNK_SIZE - 1}` }, signal });
  if (!first.ok || !first.body) throw new Error(`GET ${url} → HTTP ${first.status}`);
  const total = first.status === 206 ? parseTotalFromContentRange(first.headers.get("content-range")) : undefined;
  if (total === undefined) {
    // Ranges not supported (plain 200): stream this response sequentially.
    return streamToFile(first, dest, signal, onProgress);
  }
  await writeMeta(dest, total);
  return chunkedDownload(url, dest, total, first, fetchImpl, signal, onProgress);
}

async function chunkedDownload(
  url: string,
  dest: string,
  total: number,
  firstResponse: Response | undefined,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  onProgress: (done: number, total: number | undefined) => void,
): Promise<void> {
  const chunkCount = Math.max(1, Math.ceil(total / CHUNK_SIZE));
  const chunkBytes = new Array<number>(chunkCount).fill(0);
  const reportSum = (): void => {
    let done = 0;
    for (const bytes of chunkBytes) done += bytes;
    onProgress(done, total);
  };

  const expectedSize = (index: number): number => Math.min(CHUNK_SIZE, total - index * CHUNK_SIZE);
  const partPath = (index: number): string => `${dest}.part-${index}`;

  const fetchChunk = async (index: number): Promise<void> => {
    const expected = expectedSize(index);
    const existing = await fileSize(partPath(index));
    if (existing === expected) {
      // Resumed part: discard the pre-fetched probe response instead of streaming it.
      if (index === 0 && firstResponse) void firstResponse.body?.cancel().catch(() => undefined);
      chunkBytes[index] = expected;
      reportSum();
      return;
    }
    let res: Response;
    if (index === 0 && firstResponse) {
      res = firstResponse;
    } else {
      const from = index * CHUNK_SIZE;
      res = await fetchImpl(url, { headers: { Range: `bytes=${from}-${from + expected - 1}` }, signal });
      if (res.status !== 206 || !res.body) throw new Error(`GET ${url} range ${index} → HTTP ${res.status}`);
    }
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        chunkBytes[index] += chunk.length;
        reportSum();
        cb(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(res.body as WebReadableStream),
        counter,
        fs.createWriteStream(partPath(index)),
        { signal },
      );
    } catch (err) {
      chunkBytes[index] = 0; // an incomplete part is re-fetched next time
      throw err;
    }
    if ((await fileSize(partPath(index))) !== expected) {
      chunkBytes[index] = 0;
      await fs.promises.rm(partPath(index), { force: true });
      throw new Error(`GET ${url} range ${index}: truncated response`);
    }
    chunkBytes[index] = expected;
    reportSum();
  };

  // Bounded worker pool over the chunk indices.
  let next = 0;
  const workers = Array.from({ length: Math.min(CHUNK_CONCURRENCY, chunkCount) }, async () => {
    while (next < chunkCount) {
      const index = next;
      next += 1;
      await fetchChunk(index);
    }
  });
  await Promise.all(workers);

  // Assemble atomically, then drop the parts and the meta sidecar.
  const partial = `${dest}.partial`;
  const out = fs.createWriteStream(partial);
  try {
    for (let i = 0; i < chunkCount; i += 1) {
      await pipeline(fs.createReadStream(partPath(i)), out, { end: false, signal });
    }
    out.end();
    await finished(out);
  } catch (err) {
    out.destroy();
    await fs.promises.rm(partial, { force: true });
    throw err;
  }
  await fs.promises.rename(partial, dest);
  await Promise.all([
    fs.promises.rm(`${dest}.meta.json`, { force: true }),
    ...Array.from({ length: chunkCount }, (_v, i) => fs.promises.rm(partPath(i), { force: true })),
  ]);
}

/** Single-stream fallback for servers without range support; atomic via `.partial` + rename. */
async function streamToFile(
  res: Response,
  dest: string,
  signal: AbortSignal,
  onProgress: (done: number, total: number | undefined) => void,
): Promise<void> {
  const total = Number(res.headers.get("content-length")) || undefined;
  const partial = `${dest}.partial`;
  let done = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      done += chunk.length;
      onProgress(done, total);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as WebReadableStream), counter, fs.createWriteStream(partial), {
      signal,
    });
  } catch (err) {
    await fs.promises.rm(partial, { force: true });
    throw err;
  }
  await fs.promises.rename(partial, dest);
}

function parseTotalFromContentRange(header: string | null): number | undefined {
  const match = header?.match(/\/(\d+)\s*$/);
  const total = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

async function readMeta(dest: string): Promise<number | undefined> {
  try {
    // Widen `any` from JSON.parse to unknown values; the read below is typeof-checked.
    const raw = JSON.parse(await fs.promises.readFile(`${dest}.meta.json`, "utf8")) as Record<string, unknown>;
    return typeof raw.total === "number" && raw.total > 0 ? raw.total : undefined;
  } catch {
    return undefined;
  }
}

async function writeMeta(dest: string, total: number): Promise<void> {
  await fs.promises.writeFile(`${dest}.meta.json`, JSON.stringify({ total }));
}

function upload(
  sftp: SFTPWrapper,
  local: string,
  remote: string,
  signal: AbortSignal | undefined,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  sftp.fastPut(
    local,
    remote,
    {
      step: (transferred, _chunk, total) => {
        onProgress(transferred, total);
        if (signal?.aborted) sftp.end();
      },
    },
    (err) => (err ? reject(err) : resolve()),
  );
  return promise;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(p: string): Promise<number | undefined> {
  try {
    return (await fs.promises.stat(p)).size;
  } catch {
    return undefined;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
}

function formatMb(bytes: number): string {
  return (bytes / 1_048_576).toFixed(0);
}

/** Map `done/total` onto the [from..to] percent band (returns `from` when total is unknown). */
function scale(done: number, total: number | undefined, from: number, to: number): number {
  if (!total) return from;
  return from + Math.min(1, done / total) * (to - from);
}
