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

/**
 * Obtains the Cloud.ru console OIDC Bearer the same way the web app gets it: drive a browser to
 * console.cloud.ru, let the user sign in (SSO), and read the `iframe_auth_cookie` (= the access token)
 * via CDP. A persistent browser profile keeps the SSO session so later mints are silent/headless. No
 * IAM app registration, no key/secret.
 */
export class ConsoleTokenProvider {
  private cached: string | undefined;
  /** Serializes browser launches so concurrent callers never collide on the profile's SingletonLock. */
  private chain: Promise<string | undefined> = Promise.resolve(undefined);
  private readonly onDidChange = new vscode.EventEmitter<boolean>();
  readonly onDidChangeAuth = this.onDidChange.event;

  constructor(private readonly deps: { context: vscode.ExtensionContext; logger: Logger }) {}

  async isSignedIn(): Promise<boolean> {
    return this.deps.context.globalState.get<boolean>(SIGNED_IN_KEY, false);
  }

  async signIn(): Promise<boolean> {
    const token = await this.mint(true);
    if (!token) return false;
    await this.deps.context.globalState.update(SIGNED_IN_KEY, true);
    this.onDidChange.fire(true);
    return true;
  }

  async signOut(): Promise<void> {
    this.cached = undefined;
    await this.deps.context.globalState.update(SIGNED_IN_KEY, false);
    this.onDidChange.fire(false);
  }

  /** Valid Bearer for the console API, minting silently from the persisted session when expired. */
  async getAccessToken(): Promise<string> {
    if (this.cached && !isJwtExpired(this.cached)) return this.cached;
    const token = await this.mint(false);
    if (!token) {
      throw new Error("Not signed in to Cloud.ru. Run “Cloud.ru: Sign In”.");
    }
    return token;
  }

  /** Serialize mints so two browser launches never share the profile concurrently. */
  private mint(interactive: boolean): Promise<string | undefined> {
    const next = this.chain.then(
      () => this.doMint(interactive),
      () => this.doMint(interactive),
    );
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async doMint(interactive: boolean): Promise<string | undefined> {
    // A queued earlier mint may have already refreshed the token.
    if (!interactive && this.cached && !isJwtExpired(this.cached)) return this.cached;

    const config = vscode.workspace.getConfiguration("cloudru");
    const chromePath = findChrome(config.get<string>("notebook.chromePath", ""));
    if (!chromePath) {
      void vscode.window.showErrorMessage(
        "No Chrome/Chromium found for sign-in. Set “cloudru.notebook.chromePath” to a browser executable.",
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
    const browser = await puppeteer.launch({
      headless: !interactive,
      executablePath: chromePath,
      userDataDir,
      defaultViewport: null,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    try {
      const page = (await browser.pages())[0] ?? (await browser.newPage());
      const client = await page.target().createCDPSession();
      await page.goto(consoleUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);

      const deadline = Date.now() + (interactive ? 300_000 : 30_000);
      while (Date.now() < deadline) {
        let cookies: CdpCookie[];
        try {
          ({ cookies } = (await client.send("Network.getAllCookies")) as { cookies: CdpCookie[] });
        } catch {
          break; // window/CDP closed
        }
        const match = cookies.find((c) => c.name === SESSION_COOKIE && c.value && !isJwtExpired(c.value));
        if (match) {
          this.cached = match.value;
          return match.value;
        }
        await delay(800);
      }
      return undefined;
    } catch (err) {
      this.deps.logger.error("Console token mint failed", err);
      return undefined;
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  dispose(): void {
    this.onDidChange.dispose();
  }
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
