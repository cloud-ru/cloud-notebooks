// Pure helpers for editing an OpenSSH `config` file. No `vscode` → unit-testable.

export interface SshHostEntry {
  host: string;
  port: number;
  username: string;
  identityFile: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace or append a clearly-marked managed `Host` stanza for `alias` in an ssh config file. */
export function upsertSshConfigBlock(existing: string, alias: string, stanza: string): string {
  const begin = `# >>> cloud.ru:${alias} >>>`;
  const end = `# <<< cloud.ru:${alias} <<<`;
  const block = `${begin}\n${stanza}\n${end}`;
  const re = new RegExp(`${escapeRegex(begin)}[\\s\\S]*?${escapeRegex(end)}`);
  if (re.test(existing)) return existing.replace(re, block);
  const prefix = existing.trim() ? `${existing.replace(/\s*$/, "")}\n\n` : "";
  return `${prefix}${block}\n`;
}

/** Build the SSH `Host` stanza. Paths are quoted to tolerate spaces; RSA fallback is enabled. */
export function formatHostStanza(alias: string, entry: SshHostEntry, knownHostsFile: string): string {
  return [
    `Host ${alias}`,
    `  HostName ${entry.host}`,
    `  User ${entry.username}`,
    `  Port ${entry.port}`,
    `  IdentityFile "${entry.identityFile}"`,
    `  IdentitiesOnly yes`,
    `  HostKeyAlgorithms +ssh-rsa`,
    `  PubkeyAcceptedAlgorithms +ssh-rsa`,
    `  StrictHostKeyChecking yes`,
    `  UserKnownHostsFile "${knownHostsFile}"`,
  ].join("\n");
}
