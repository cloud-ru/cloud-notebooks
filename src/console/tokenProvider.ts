import * as fs from "node:fs";
import * as vscode from "vscode";
import type { Browser, PuppeteerNode } from "puppeteer-core" with { "resolution-mode": "import" };
import { isJwtExpired, JWT_EXPIRY_SKEW_MS, jwtAccountFingerprint, jwtExpiryMs } from "../auth/jwt";
import { findChrome } from "../jupyter/chrome";
import type { Logger } from "../util/logger";
import { FIXED_KEY_COOKIE_FLAGS, retireFixedKeyCookies } from "./profileCookies";

const SIGNED_IN_KEY = "cloudru.console.signedIn";
/** Fingerprint of the account the user signed in with (see jwtAccountFingerprint). */
const ACCOUNT_KEY = "cloudru.console.account";
const SESSION_COOKIE = "iframe_auth_cookie";
const DEFAULT_CONSOLE_URL = "https://console.cloud.ru/";
/** First keep-alive check after activation. Leaves the startup mint to the initial list load, which
 * explains the wait in the tree ("signing in…"). */
const KEEP_ALIVE_FIRST_CHECK_MS = 15_000;
/** Longest gap between keep-alive checks. Node timers don't count time the machine sleeps, so this also
 * bounds how late the first check after wake-up can be. A check with a fresh token launches nothing. */
const KEEP_ALIVE_MAX_WAIT_MS = 5 * 60_000;
/** Back-off after transient background failures (offline, profile busy in another window). */
const KEEP_ALIVE_RETRY_MS = [60_000, 2 * 60_000, 5 * 60_000];
/** Keep-alive pauses after this long without user activity in the window, so a machine left unattended
 * with VS Code open still lets the IdP idle timeout end the session. */
const KEEP_ALIVE_IDLE_LIMIT_MS = 8 * 60 * 60_000;

/** Loaded on the first mint, then reused: puppeteer-core ≥ 25 is ESM-only and the extension bundle is
 * CommonJS with puppeteer-core left external, so a static import would become require(esm). A real
 * import() avoids relying on that; the type import above needs `resolution-mode` for the same reason. */
let puppeteer: PuppeteerNode | undefined;

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
}

export class TokenMintError extends Error {
  constructor(readonly reason: "browser" | "navigation" | "network", message: string) {
    super(message);
    this.name = "TokenMintError";
  }
}

/** Thrown when the persisted Cloud.ru session can no longer mint a token (SSO expired/revoked). Lets
 * callers distinguish "must re-authenticate" from real load failures so they skip the generic error
 * toast — the provider already flips auth state and prompts. */
export class NotSignedInError extends Error {
  constructor() {
    super("Вход в Cloud.ru не выполнен. Выполните команду «Cloud.ru: Войти».");
    this.name = "NotSignedInError";
  }
}

/**
 * Obtains the Cloud.ru console OIDC Bearer the same way the web app gets it: drive a browser to
 * console.cloud.ru, let the user sign in (SSO), and read the `iframe_auth_cookie` (= the access token)
 * via CDP. A persistent browser profile keeps the SSO session so later mints are silent/headless. No
 * IAM app registration, no key/secret.
 */
export class ConsoleTokenProvider {
  private cached: string | undefined;
  /** One-shot guard for the "session expired" prompt so concurrent failed mints don't stack toasts;
   * reset on the next successful mint. */
  private expiryAnnounced = false;
  /** Serializes browser launches so concurrent callers never collide on the profile's SingletonLock. */
  private chain: Promise<string | undefined> = Promise.resolve(undefined);
  private generation = 0;
  private readonly activeMints = new Set<AbortController>();
  private readonly onDidChange = new vscode.EventEmitter<boolean>();
  readonly onDidChangeAuth = this.onDidChange.event;
  /** Fires while a silent (headless) mint is in flight, so the tree can show "signing in…" instead of
   * a bare, seemingly-stuck spinner after a window reload. */
  private readonly onMinting = new vscode.EventEmitter<boolean>();
  readonly onDidChangeMinting = this.onMinting.event;
  private minting = 0;
  /** An interactive browser window is waiting for the user; a second sign-in must not open another. */
  private signingIn = false;
  private disposed = false;
  private keepAliveStarted = false;
  private keepAliveRunning = false;
  private keepAliveTimer: NodeJS.Timeout | undefined;
  private keepAliveFailures = 0;
  /** A background refresh already came back without a token once; the next miss signs out. */
  private keepAliveMissed = false;
  private lastActivityAt = Date.now();
  private windowStateListener: vscode.Disposable | undefined;
  /** Cookies saved under the fixed key were just deleted; explains the one-time sign-in prompt. */
  private cookieStoreReset = false;

  constructor(private readonly deps: { context: vscode.ExtensionContext; logger: Logger }) {}

  /** Synchronous view of the persisted flag, for UI that must change in the same tick as auth. */
  get signedIn(): boolean {
    return this.deps.context.globalState.get<boolean>(SIGNED_IN_KEY, false);
  }

  async isSignedIn(): Promise<boolean> {
    return this.signedIn;
  }

  /** True when the last sign-out was due to an expired SSO session (vs an explicit sign-out or a
   * fresh, never-signed-in state). Drives the "session expired" welcome view. */
  get sessionExpired(): boolean {
    return this.expiryAnnounced;
  }

  /** Interactive sign-in: opens a real browser window and waits for the SSO cookie. Wrapped in a
   * cancellable progress notification so the user knows the extension is waiting on the browser, and
   * so cancelling actually closes the window instead of leaving it stranded for up to 5 minutes. */
  async signIn(): Promise<boolean> {
    for (;;) {
      if (this.signingIn) {
        // The welcome view, title bar, status bar and expiry toast all lead here.
        void vscode.window.showInformationMessage("Вход в Cloud.ru уже выполняется — завершите его в окне браузера.");
        return false;
      }
      const generation = this.generation;
      let cancelled = false;
      let token: string | undefined;
      this.signingIn = true;
      try {
        token = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            cancellable: true,
            title: "Завершите вход в окне браузера Cloud.ru…",
          },
          (_progress, cancelToken) => {
            const controller = new AbortController();
            cancelToken.onCancellationRequested(() => {
              cancelled = true;
              controller.abort();
            });
            return this.mint(true, controller.signal);
          },
        );
      } finally {
        this.signingIn = false;
      }
      if (token && generation === this.generation) {
        await this.deps.context.globalState.update(SIGNED_IN_KEY, true);
        this.onDidChange.fire(true);
        return true;
      }
      if (cancelled) return false;
      const RETRY = "Повторить";
      const choice = await vscode.window.showErrorMessage("Вход в Cloud.ru не выполнен.", RETRY);
      if (choice !== RETRY) return false;
    }
  }

  async signOut(): Promise<void> {
    this.generation++;
    this.stopKeepAlive();
    for (const controller of this.activeMints) controller.abort();
    this.cached = undefined;
    this.expiryAnnounced = false; // explicit sign-out is not an "expired session"
    await this.deps.context.globalState.update(SIGNED_IN_KEY, false);
    await this.deps.context.globalState.update(ACCOUNT_KEY, undefined);
    this.onDidChange.fire(false);
  }

  /** A silent mint failed → the persisted SSO session is gone. Flip to signed-out (so the tree shows
   * its sign-in welcome view and later calls short-circuit instead of each stalling ~30s on a headless
   * mint) and prompt the user to re-authenticate. One-shot until the next successful sign-in. Public so
   * command error handling can route a post-retry 401 through the same single path. */
  async handleExpiredSession(): Promise<void> {
    if (this.expiryAnnounced || !this.signedIn) return;
    this.expiryAnnounced = true;
    this.generation++;
    this.stopKeepAlive();
    for (const controller of this.activeMints) controller.abort();
    this.cached = undefined;
    this.deps.logger.info("Cloud.ru session expired; signed out and prompting to sign in again.");
    await this.deps.context.globalState.update(SIGNED_IN_KEY, false);
    this.onDidChange.fire(false);
    void this.promptReauth();
  }

  private async promptReauth(): Promise<void> {
    const SIGN_IN = "Войти";
    const choice = await vscode.window.showWarningMessage(
      this.cookieStoreReset
        ? "Сохранённый вход Cloud.ru перенесён в защищённое хранилище системы — войдите один раз заново."
        : "Сессия Cloud.ru истекла. Войдите снова, чтобы работать с ноутбуками и ядрами.",
      SIGN_IN,
    );
    // Same entry point as the view and status-bar buttons, so the workspace and preflight come back
    // too. Skip it if the user already signed in elsewhere while this toast sat in the center.
    if (choice === SIGN_IN && !this.signedIn) await vscode.commands.executeCommand("cloudru.signIn");
  }

  /** Valid Bearer for the console API, minting silently from the persisted session when expired.
   * `forceRefresh` discards the cached token (e.g. after a 401) so the next call re-mints. */
  async getAccessToken(forceRefresh = false): Promise<string> {
    // Never launch a (headless) browser when the user isn't signed in — that is a 30s stall for
    // nothing. Only the interactive signIn() path may open a browser while signed out.
    if (!this.signedIn) throw new NotSignedInError();
    const generation = this.generation;
    if (forceRefresh) this.cached = undefined;
    if (this.cached && !isJwtExpired(this.cached)) return this.cached;
    const token = await this.withMinting(() => this.mint(false));
    if (generation !== this.generation || !this.signedIn) throw new NotSignedInError();
    if (!token) {
      await this.handleExpiredSession();
      throw new NotSignedInError();
    }
    return token;
  }

  /**
   * Keeps the SSO session warm while the editor is open: refreshes the token in the background at the
   * moment an API call would otherwise have to mint it, whether or not the window is focused. An idle
   * session then never times out on the IdP side, and API calls rarely wait on a headless browser.
   * Paused while signed out (resumes on the next successful sign-in) and after hours without user
   * activity in the window (resumes on the next one).
   */
  startKeepAlive(): void {
    this.keepAliveStarted = true;
    this.windowStateListener ??= vscode.window.onDidChangeWindowState((state) => {
      if (isUserActive(state)) this.lastActivityAt = Date.now();
    });
    this.scheduleKeepAlive(KEEP_ALIVE_FIRST_CHECK_MS);
  }

  private scheduleKeepAlive(delayMs = this.msUntilRefreshDue()): void {
    clearTimeout(this.keepAliveTimer);
    this.keepAliveTimer = undefined;
    if (!this.keepAliveStarted || this.disposed) return;
    const wait = Math.min(Math.max(delayMs, 1_000), KEEP_ALIVE_MAX_WAIT_MS);
    this.keepAliveTimer = setTimeout(() => void this.keepAliveTick(), wait);
  }

  private stopKeepAlive(): void {
    clearTimeout(this.keepAliveTimer);
    this.keepAliveTimer = undefined;
    this.keepAliveFailures = 0;
    this.keepAliveMissed = false;
  }

  /** When the cached token stops being served by getAccessToken (≤ 0: due now). */
  private msUntilRefreshDue(): number {
    const expiry = this.cached ? jwtExpiryMs(this.cached) : undefined;
    return expiry === undefined ? 0 : expiry - JWT_EXPIRY_SKEW_MS - Date.now();
  }

  private async keepAliveTick(): Promise<void> {
    this.keepAliveTimer = undefined;
    if (this.keepAliveRunning) return; // the running check reschedules when it ends
    this.keepAliveRunning = true;
    try {
      const next = await this.keepAliveCheck();
      if (next !== undefined) this.scheduleKeepAlive(next);
    } finally {
      this.keepAliveRunning = false;
    }
  }

  /** One keep-alive pass. Returns the delay before the next one, or undefined to pause until the next
   * successful sign-in. Never fires onDidChangeMinting: nobody is waiting on a background refresh. */
  private async keepAliveCheck(): Promise<number | undefined> {
    if (this.disposed || !this.signedIn) return undefined;
    const enabled = vscode.workspace.getConfiguration("cloudru").get<boolean>("console.keepSessionAlive", true);
    if (!enabled) return KEEP_ALIVE_MAX_WAIT_MS;
    if (isUserActive(vscode.window.state)) this.lastActivityAt = Date.now();
    if (Date.now() - this.lastActivityAt > KEEP_ALIVE_IDLE_LIMIT_MS) return KEEP_ALIVE_MAX_WAIT_MS;
    if (this.cached && !isJwtExpired(this.cached)) return this.msUntilRefreshDue();
    // A foreground mint is already refreshing; its success reschedules from the new token.
    if (this.activeMints.size > 0) return KEEP_ALIVE_RETRY_MS[0];
    const generation = this.generation;
    let token: string | undefined;
    try {
      token = await this.mint(false);
    } catch (err) {
      // Offline, browser missing, or the profile is busy in another window: the session itself may be
      // fine, so keep the user signed in and retry with back-off.
      const delay = KEEP_ALIVE_RETRY_MS[Math.min(this.keepAliveFailures++, KEEP_ALIVE_RETRY_MS.length - 1)];
      this.deps.logger.warn(`Background Cloud.ru session refresh failed; retrying in ${delay / 1000}s: ${errorText(err)}`);
      return delay;
    }
    if (generation !== this.generation || !this.signedIn) return undefined;
    if (token) return this.msUntilRefreshDue();
    if (!this.keepAliveMissed) {
      // No fresh token usually means the SSO session is gone, but a flaky network right after wake-up
      // looks the same. Nobody waits on a background refresh, so confirm once before signing out.
      this.keepAliveMissed = true;
      this.deps.logger.warn("Background Cloud.ru session refresh got no token; confirming before sign-out.");
      return KEEP_ALIVE_RETRY_MS[0];
    }
    await this.handleExpiredSession();
    return undefined;
  }

  /** Serialize mints so two browser launches never share the profile concurrently. */
  private mint(interactive: boolean, signal?: AbortSignal): Promise<string | undefined> {
    const controller = new AbortController();
    const generation = this.generation;
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    this.activeMints.add(controller);
    const next = this.chain.then(
      () => this.doMint(interactive, controller.signal, generation),
      () => this.doMint(interactive, controller.signal, generation),
    ).finally(() => {
      signal?.removeEventListener("abort", onAbort);
      this.activeMints.delete(controller);
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Runs a silent mint while broadcasting `onDidChangeMinting`, ref-counted so overlapping mints flip
   * the flag exactly once at the edges. */
  private async withMinting<T>(run: () => Promise<T>): Promise<T> {
    if (this.minting++ === 0) this.onMinting.fire(true);
    try {
      return await run();
    } finally {
      if (--this.minting === 0) this.onMinting.fire(false);
    }
  }

  /** Account pinned at sign-in, or none yet (signed in before pinning existed: first refresh pins it). */
  private isSignedInAccount(token: string): boolean {
    const pinned = this.deps.context.globalState.get<string>(ACCOUNT_KEY);
    return !pinned || jwtAccountFingerprint(token) === pinned;
  }

  private async doMint(interactive: boolean, signal: AbortSignal, generation: number): Promise<string | undefined> {
    if (signal.aborted || generation !== this.generation) return undefined;
    // A queued earlier mint may have already refreshed the token.
    if (!interactive && this.cached && !isJwtExpired(this.cached)) return this.cached;

    const config = vscode.workspace.getConfiguration("cloudru");
    const chromePath = findChrome(config.get<string>("notebook.chromePath", ""));
    if (!chromePath) {
      throw new TokenMintError("browser", "Не найден Chrome/Chromium. Укажите путь в «cloudru.notebook.chromePath».");
    }
    const consoleUrl = config.get<string>("console.url", DEFAULT_CONSOLE_URL);
    const userDataDir = vscode.Uri.joinPath(this.deps.context.globalStorageUri, "console-profile").fsPath;
    fs.mkdirSync(userDataDir, { recursive: true });
    if (retireFixedKeyCookies(userDataDir)) {
      this.cookieStoreReset = true;
      this.deps.logger.info("Sign-in profile switched to the OS secret store; cookies saved under the fixed key were deleted.");
    }
    let browser: Browser;
    try {
      puppeteer ??= (await import("puppeteer-core")).default;
      if (signal.aborted || generation !== this.generation) return undefined;
      browser = await puppeteer.launch({
        headless: !interactive,
        executablePath: chromePath,
        userDataDir,
        defaultViewport: null,
        args: ["--no-first-run", "--no-default-browser-check"],
        ignoreDefaultArgs: FIXED_KEY_COOKIE_FLAGS,
      });
    } catch (error) {
      if (signal.aborted) return undefined;
      throw new TokenMintError("browser", `Не удалось открыть Chrome для Cloud.ru: ${String(error)}`);
    }
    // Cancelling the sign-in progress must actually close the window, not orphan it for 5 min.
    const onAbort = (): void => void browser.close().catch(() => undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal.aborted || generation !== this.generation) return undefined;
      const page = (await browser.pages())[0] ?? (await browser.newPage());
      const client = await page.createCDPSession();
      try {
        await page.goto(consoleUrl, { waitUntil: "domcontentloaded" });
      } catch (error) {
        if (signal.aborted) return undefined;
        throw new TokenMintError("navigation", `Не удалось открыть Cloud.ru: ${String(error)}`);
      }

      const deadline = Date.now() + (interactive ? 300_000 : 30_000);
      const host = new URL(consoleUrl).hostname.toLowerCase();
      let foreignAccountLogged = false;
      while (Date.now() < deadline) {
        if (signal.aborted || generation !== this.generation) return undefined;
        let cookies: CdpCookie[];
        try {
          ({ cookies } = (await client.send("Network.getAllCookies")) as { cookies: CdpCookie[] });
        } catch (error) {
          if (signal.aborted) return undefined;
          throw new TokenMintError("network", `Не удалось проверить сессию Cloud.ru: ${String(error)}`);
        }
        if (signal.aborted || generation !== this.generation) return undefined;
        const fresh = sessionCookies(cookies, host);
        // Interactive sign-in is the trust anchor: the account the user signs in with becomes the
        // signed-in account. Silent refreshes must stay on it, so a planted cookie can't swap accounts.
        const match = interactive ? fresh[0] : fresh.find((c) => this.isSignedInAccount(c.value));
        if (match) {
          const account = jwtAccountFingerprint(match.value);
          const pinned = this.deps.context.globalState.get<string>(ACCOUNT_KEY);
          // A sign-in re-pins (or clears, for a token without `sub`); a refresh only fills an empty pin.
          if (interactive ? account !== pinned : account && !pinned) {
            await this.deps.context.globalState.update(ACCOUNT_KEY, account);
            if (signal.aborted || generation !== this.generation) return undefined;
          }
          this.cached = match.value;
          this.expiryAnnounced = false;
          this.cookieStoreReset = false;
          this.keepAliveFailures = 0;
          this.keepAliveMissed = false;
          this.scheduleKeepAlive();
          return match.value;
        }
        if (fresh.length && !foreignAccountLogged) {
          foreignAccountLogged = true;
          this.deps.logger.warn("Ignoring a Cloud.ru session cookie issued to another account than the signed-in one.");
        }
        await delay(800, signal);
      }
      return undefined;
    } catch (err) {
      if (signal.aborted) return undefined;
      if (err instanceof TokenMintError) throw err;
      this.deps.logger.error("Console token mint failed", err);
      throw new TokenMintError("network", `Не удалось получить токен Cloud.ru: ${String(err)}`);
    } finally {
      signal.removeEventListener("abort", onAbort);
      await browser.close().catch(() => undefined);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.stopKeepAlive();
    this.windowStateListener?.dispose();
    for (const controller of this.activeMints) controller.abort();
    this.onDidChange.dispose();
    this.onMinting.dispose();
  }
}

/** Unexpired session cookies visible to the console host, most specific domain first: the console's
 * own cookie outranks one set on a parent domain, where any *.cloud.ru site could have planted it. */
function sessionCookies(cookies: CdpCookie[], host: string): CdpCookie[] {
  const candidates: { cookie: CdpCookie; domain: string }[] = [];
  for (const cookie of cookies) {
    const domain = cookie.domain?.replace(/^\./, "").toLowerCase();
    if (cookie.name !== SESSION_COOKIE || !cookie.value || isJwtExpired(cookie.value) || !domain) continue;
    if (host === domain || host.endsWith(`.${domain}`)) candidates.push({ cookie, domain });
  }
  return candidates.sort((a, b) => b.domain.length - a.domain.length).map(({ cookie }) => cookie);
}

/** `active` (recent input), not `focused`: a window left in front of an empty desk stays focused. Hosts
 * predating `active` (VS Code < 1.89) fall back to focus. */
function isUserActive(state: vscode.WindowState): boolean {
  return (state.active as boolean | undefined) ?? state.focused;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
