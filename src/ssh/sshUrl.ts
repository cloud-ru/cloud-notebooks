// Pure helpers for SSH target derivation. No `vscode` → unit-testable.
//
// Two ways to obtain the gateway connection, preferred first:
//   1. Auto-build from console data (no manual copy): account id = the workspace namespace, host/port
//      = the console SSH-config endpoint (its `region_type` taken from the notebook, see
//      `regionTypeFromNotebookUrl`), server name = the notebook name.
//   2. Parse the command from the console's "Подключение по SSH" dialog (manual override / recovery):
//        ssh my-notebook.ai0000000-00001@ssh-jupyter.ai.cloud.ru -p 2222 -i <key>
//             └── server name ──┘ └─ account id ─┘ └──────── gateway host ────────┘

export interface ParsedSshCommand {
  host: string;
  port: number;
  serverName: string;
  accountId: string;
}

export const DEFAULT_SSH_HOST = "ssh-jupyter.ai.cloud.ru";
export const DEFAULT_SSH_PORT = 2222;
export const DEFAULT_REGION_TYPE = "MT";

export interface SshEndpoint {
  host: string;
  port: number;
  accountId: string;
}

/**
 * The `region_type` query param for the console SSH-config endpoint, read from the notebook URL
 * prefix suffix (`/a100-mt/notebook/…` → `MT`); defaults to `MT` when there is no recognizable suffix.
 */
export function regionTypeFromNotebookUrl(url: string | null | undefined): string {
  if (!url) return DEFAULT_REGION_TYPE;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return DEFAULT_REGION_TYPE;
  }
  const segment = pathname.split("/").find((part) => part.length > 0);
  const dash = segment ? segment.lastIndexOf("-") : -1;
  return segment && dash >= 0 ? segment.slice(dash + 1).toUpperCase() : DEFAULT_REGION_TYPE;
}

/** Parse the SSH command shown in the console's SSH dialog. */
export function parseSshCommand(command: string): ParsedSshCommand | undefined {
  const userHost = command.match(/([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+)/);
  if (!userHost) return undefined;
  const [, user, host] = userHost;
  const dot = user.indexOf(".");
  if (dot <= 0 || dot >= user.length - 1) return undefined;

  const portMatch = command.match(/-p\s+(\d+)/);
  const port = portMatch ? Number(portMatch[1]) : DEFAULT_SSH_PORT;
  return { host, port, serverName: user.slice(0, dot), accountId: user.slice(dot + 1) };
}

export function buildUsername(serverName: string, accountId: string): string {
  return `${serverName}.${accountId}`;
}
