// Parses the various shapes a Cloud.ru service-account Access Key can be pasted in. Pure module
// (no `vscode`) so it is unit-testable. Lets the user paste a single value FM-style instead of two
// separate fields.

export interface AccessKey {
  clientId: string;
  clientSecret: string;
}

const ID_KEYS = ["client_id", "keyId", "key_id", "id", "access_key_id", "login"];
const SECRET_KEYS = ["client_secret", "keySecret", "key_secret", "secret", "access_key_secret", "password"];

/**
 * Accepts:
 *  - JSON the console hands out, e.g. {"key_id":"…","secret":"…"} or {"client_id":…,"client_secret":…}
 *  - "KEY_ID:KEY_SECRET" (split on the first colon)
 * Returns undefined when the value cannot be interpreted as an id + secret pair.
 */
export function parseAccessKey(raw: string): AccessKey | undefined {
  const text = raw.trim();
  if (!text) return undefined;

  if (text.startsWith("{")) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    const pick = (keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = obj[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
      return undefined;
    };
    const clientId = pick(ID_KEYS);
    const clientSecret = pick(SECRET_KEYS);
    return clientId && clientSecret ? { clientId, clientSecret } : undefined;
  }

  const idx = text.indexOf(":");
  if (idx > 0 && idx < text.length - 1) {
    return { clientId: text.slice(0, idx).trim(), clientSecret: text.slice(idx + 1).trim() };
  }
  return undefined;
}
