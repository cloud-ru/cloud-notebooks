import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { retireFixedKeyCookies } from "../../src/console/profileCookies";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudru-cookies-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function touch(...parts: string[]): string {
  const file = path.join(dir, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
  return file;
}

describe("retireFixedKeyCookies", () => {
  it("deletes the old and the current cookie databases but keeps the rest of the profile", () => {
    const cookieFiles = [
      touch("Default", "Cookies"), touch("Default", "Cookies-journal"),
      touch("Default", "Network", "Cookies"), touch("Default", "Network", "Cookies-journal"),
    ];
    const kept = touch("Default", "Local Storage", "leveldb", "000001.log");
    expect(retireFixedKeyCookies(dir, "darwin")).toBe(true);
    for (const file of cookieFiles) expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(kept)).toBe(true);
  });

  it("runs once: cookies Chrome writes afterwards under the OS key stay", () => {
    touch("Default", "Network", "Cookies");
    expect(retireFixedKeyCookies(dir, "linux")).toBe(true);
    const fresh = touch("Default", "Network", "Cookies");
    expect(retireFixedKeyCookies(dir, "linux")).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("reports nothing to sign in again for an empty profile", () => {
    expect(retireFixedKeyCookies(dir, "darwin")).toBe(false);
    touch("Default", "Network", "Cookies");
    expect(retireFixedKeyCookies(dir, "darwin")).toBe(false); // already switched
  });

  it("leaves Windows profiles alone (DPAPI is used either way)", () => {
    const cookies = touch("Default", "Network", "Cookies");
    expect(retireFixedKeyCookies(dir, "win32")).toBe(false);
    expect(fs.existsSync(cookies)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(["Default"]); // no marker either
  });
});
