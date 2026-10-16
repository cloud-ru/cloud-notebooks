// Cookie storage of the sign-in browser profile. Pure Node (no `vscode`) → unit-testable on a temp dir.
import * as fs from "node:fs";
import * as path from "node:path";

/** Chrome flags puppeteer adds by default that encrypt the profile's cookies — the Cloud.ru SSO session
 * included — with a fixed, publicly known key (macOS mock keychain, Linux "basic" store). Without them
 * Chrome uses the OS store: Keychain, libsecret or KWallet. Windows always uses DPAPI. */
export const FIXED_KEY_COOKIE_FLAGS = ["--use-mock-keychain", "--password-store=basic"];

const MARKER = ".os-cookie-store";
/** Chrome's cookie database, before and after it moved under Network/ (Chrome 96). */
const COOKIE_FILES = [
  ["Default", "Cookies"],
  ["Default", "Cookies-journal"],
  ["Default", "Network", "Cookies"],
  ["Default", "Network", "Cookies-journal"],
];

/**
 * Deletes, once per profile, the cookie database written under the fixed key: macOS can't decrypt it
 * with the OS key anyway, and on Linux it would otherwise stay readable by anyone with a copy of the
 * profile. Local storage and cache are kept. Windows is unaffected by the flags, so nothing changes
 * there. The marker is created exclusively, so only one editor window does this. Returns true when
 * saved cookies were removed, i.e. the user will have to sign in again.
 */
export function retireFixedKeyCookies(userDataDir: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return false;
  try {
    fs.writeFileSync(path.join(userDataDir, MARKER), "", { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false; // done earlier, maybe by another window
    throw err;
  }
  let removed = false;
  for (const parts of COOKIE_FILES) {
    const file = path.join(userDataDir, ...parts);
    if (!fs.existsSync(file)) continue;
    fs.rmSync(file, { force: true });
    removed = true;
  }
  return removed;
}
