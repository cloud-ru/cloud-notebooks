import puppeteer from "puppeteer-core";
import { parseNotebookUrl } from "./notebookUrl";

export interface CaptureOptions {
  /** Full notebook URL (the one opened in the browser today). */
  notebookUrl: string;
  /** Path to a Chromium-family executable to drive. */
  chromePath: string;
  /** Persistent profile dir so the id.cloud.ru SSO session survives between logins. */
  userDataDir: string;
  /** How long to wait for the user to finish the login. Default 5 min. */
  timeoutMs?: number;
}

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
}

/**
 * Opens a controlled browser window at the notebook URL, lets the user complete the cloud.ru OIDC
 * login, then reads the `authservice_session` cookie the proxy sets. Returns the cookie pair
 * (`authservice_session=...`) for the shim to inject. Throws if the window is closed or the timeout
 * elapses before the session appears.
 */
export async function captureNotebookSession(opts: CaptureOptions): Promise<string> {
  const { origin } = parseNotebookUrl(opts.notebookUrl);
  const host = new URL(origin).host;

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: opts.chromePath,
    userDataDir: opts.userDataDir,
    defaultViewport: null,
    args: ["--no-first-run", "--no-default-browser-check"],
  });

  try {
    const pages = await browser.pages();
    const page = pages[0] ?? (await browser.newPage());
    const client = await page.target().createCDPSession();
    await page.goto(opts.notebookUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);

    const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
    while (Date.now() < deadline) {
      let cookies: CdpCookie[];
      try {
        ({ cookies } = (await client.send("Network.getAllCookies")) as { cookies: CdpCookie[] });
      } catch {
        break; // window/CDP closed by the user
      }
      const match = cookies.find(
        (c) => c.name === "authservice_session" && host.endsWith(c.domain.replace(/^\./, "")),
      );
      if (match && page.url().startsWith(origin)) {
        return `authservice_session=${match.value}`;
      }
      await delay(800);
    }
    throw new Error("Login window was closed or timed out before the session was established.");
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
