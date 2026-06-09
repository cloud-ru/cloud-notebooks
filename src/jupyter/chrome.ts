import * as fs from "node:fs";

// Common install locations for a Chromium-family browser we can drive over CDP, per platform.
const CANDIDATES_BY_PLATFORM: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/usr/bin/brave-browser",
  ],
  win32: [
    `${process.env["PROGRAMFILES"] ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["LOCALAPPDATA"] ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ],
};

/** Resolve a browser executable: an explicit override wins, otherwise probe known locations. */
export function findChrome(override?: string): string | undefined {
  if (override && override.trim()) {
    return fs.existsSync(override) ? override : undefined;
  }
  for (const candidate of CANDIDATES_BY_PLATFORM[process.platform] ?? []) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
