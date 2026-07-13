import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import puppeteer from "puppeteer-core";
import { isJwtExpired } from "../auth/jwt";
import { findChrome } from "../jupyter/chrome";
import type { Logger } from "../util/logger";

const SIGNED_IN_KEY = "cloudru.console.signedIn";
const SESSION_COOKIE = "iframe_auth_cookie";
const DEFAULT_CONSOLE_URL = "https://console.cloud.ru/";

interface CdpCookie {
  name: string;
  value: string;
}

/** Thrown when the persisted Cloud.ru session can no longer mint a token (SSO expired/revoked). Lets
 * callers distinguish "must re-authenticate" from real load failures so they skip the generic error
 * toast — the provider already flips auth state and prompts. */
export class NotSignedInError extends Error {
  constructor() {
    super("Not signed in to Cloud.ru. Run “Cloud.ru: Sign In”.");
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
  private readonly onDidChange = new vscode.EventEmitter<boolean>();
  readonly onDidChangeAuth = this.onDidChange.event;
  /** Fires while a silent (headless) mint is in flight, so the tree can show "signing in…" instead of
   * a bare, seemingly-stuck spinner after a window reload (H8/1.6). */
  private readonly onMinting = new vscode.EventEmitter<boolean>();
  readonly onDidChangeMinting = this.onMinting.event;
  private minting = 0;

  constructor(private readonly deps: { context: vscode.ExtensionContext; logger: Logger }) {}

  async isSignedIn(): Promise<boolean> {
    return this.deps.context.globalState.get<boolean>(SIGNED_IN_KEY, false);
  }

  /** True when the last sign-out was due to an expired SSO session (vs an explicit sign-out or a
   * fresh, never-signed-in state). Drives the "session expired" welcome view (4.3). */
  get sessionExpired(): boolean {
    return this.expiryAnnounced;
  }

  /** Interactive sign-in: opens a real browser window and waits for the SSO cookie. Wrapped in a
   * cancellable progress notification so the user knows the extension is waiting on the browser, and
   * so cancelling actually closes the window instead of leaving it stranded for up to 5 minutes (H5). */
  async signIn(): Promise<boolean> {
    let cancelled = false;
    const token = await vscode.window.withProgress(
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
    if (token) {
      await this.deps.context.globalState.update(SIGNED_IN_KEY, true);
      this.onDidChange.fire(true);
      return true;
    }
    if (!cancelled) {
      const RETRY = "Повторить";
      const choice = await vscode.window.showErrorMessage("Вход в Cloud.ru не выполнен.", RETRY);
      if (choice === RETRY) return this.signIn();
    }
    return false;
  }

  async signOut(): Promise<void> {
    this.cached = undefined;
    this.expiryAnnounced = false; // explicit sign-out is not an "expired session"
    await this.deps.context.globalState.update(SIGNED_IN_KEY, false);
    this.onDidChange.fire(false);
  }

  /** A silent mint failed → the persisted SSO session is gone. Flip to signed-out (so the tree shows
   * its sign-in welcome view and later calls short-circuit instead of each stalling ~30s on a headless
   * mint) and prompt the user to re-authenticate. One-shot until the next successful sign-in. Public so
   * command error handling can route a post-retry 401 through the same single path (H7). */
  async handleExpiredSession(): Promise<void> {
    if (this.expiryAnnounced || !(await this.isSignedIn())) return;
    this.expiryAnnounced = true;
    this.cached = undefined;
    await this.deps.context.globalState.update(SIGNED_IN_KEY, false);
    this.onDidChange.fire(false);
    void this.promptReauth();
  }

  private async promptReauth(): Promise<void> {
    const SIGN_IN = "Войти";
    const choice = await vscode.window.showWarningMessage(
      "Сессия Cloud.ru истекла. Войдите снова, чтобы работать с ноутбуками и ядрами.",
      SIGN_IN,
    );
    if (choice === SIGN_IN) await this.signIn();
  }

  /** Valid Bearer for the console API, minting silently from the persisted session when expired.
   * `forceRefresh` discards the cached token (e.g. after a 401) so the next call re-mints. */
  async getAccessToken(forceRefresh = false): Promise<string> {
    if (forceRefresh) this.cached = undefined;
    if (this.cached && !isJwtExpired(this.cached)) return this.cached;
    // Never launch a (headless) browser when the user isn't signed in — that is a 30s stall for
    // nothing. Only the interactive signIn() path may open a browser while signed out (H2).
    if (!(await this.isSignedIn())) throw new NotSignedInError();
    const token = await this.withMinting(() => this.mint(false));
    if (!token) {
      await this.handleExpiredSession();
      throw new NotSignedInError();
    }
    return token;
  }

  /** Serialize mints so two browser launches never share the profile concurrently. */
  private mint(interactive: boolean, signal?: AbortSignal): Promise<string | undefined> {
    const next = this.chain.then(
      () => this.doMint(interactive, signal),
      () => this.doMint(interactive, signal),
    );
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

  private async doMint(interactive: boolean, signal?: AbortSignal): Promise<string | undefined> {
    // A queued earlier mint may have already refreshed the token.
    if (!interactive && this.cached && !isJwtExpired(this.cached)) return this.cached;

    const config = vscode.workspace.getConfiguration("cloudru");
    const chromePath = findChrome(config.get<string>("notebook.chromePath", ""));
    if (!chromePath) {
      void vscode.window.showErrorMessage(
        "Не найден Chrome/Chromium для входа. Укажите путь к браузеру в «cloudru.notebook.chromePath».",
      );
      return undefined;
    }
    const consoleUrl = config.get<string>("console.url", DEFAULT_CONSOLE_URL);
    const userDataDir = vscode.Uri.joinPath(this.deps.context.globalStorageUri, "console-profile").fsPath;
    fs.mkdirSync(userDataDir, { recursive: true });
    // Clear stale single-instance locks left by a crashed/not-closed previous browser.
    for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      try {
        fs.rmSync(path.join(userDataDir, lock), { force: true });
      } catch {
        // ignore
      }
    }
    if (signal?.aborted) return undefined;
    const browser = await puppeteer.launch({
      headless: !interactive,
      executablePath: chromePath,
      userDataDir,
      defaultViewport: null,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    // Cancelling the sign-in progress must actually close the window (H5), not orphan it for 5 min.
    const onAbort = (): void => void browser.close().catch(() => undefined);
    if (signal) signal.addEventListener("abort", onAbort);
    try {
      const page = (await browser.pages())[0] ?? (await browser.newPage());
      const client = await page.target().createCDPSession();
      await page.goto(consoleUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);

      const deadline = Date.now() + (interactive ? 300_000 : 30_000);
      while (Date.now() < deadline) {
        if (signal?.aborted) return undefined;
        let cookies: CdpCookie[];
        try {
          ({ cookies } = (await client.send("Network.getAllCookies")) as { cookies: CdpCookie[] });
        } catch {
          break; // window/CDP closed
        }
        const match = cookies.find((c) => c.name === SESSION_COOKIE && c.value && !isJwtExpired(c.value));
        if (match) {
          this.cached = match.value;
          this.expiryAnnounced = false;
          return match.value;
        }
        await delay(800);
      }
      return undefined;
    } catch (err) {
      this.deps.logger.error("Console token mint failed", err);
      return undefined;
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
      await browser.close().catch(() => undefined);
    }
  }

  dispose(): void {
    this.onDidChange.dispose();
    this.onMinting.dispose();
  }
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
