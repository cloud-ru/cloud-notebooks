// Pure helpers for SSH target derivation. No `vscode` → unit-testable.
//
// Real connection:
//   ssh fedos-test-beautiful-hawking.ai0001905-05529@ssh-a100-jupyter.ai.cloud.ru -p 2222 -i <key>
//        └─────────── server name ───────────┘ └── accountId ─┘ └──── pool host (a100) ─────┘
import { parseNotebookUrl } from "../jupyter/notebookUrl";

export interface SshTarget {
  host: string;
  port: number;
  username: string;
}

export interface ParsedSshCommand {
  host: string;
  port: number;
  serverName: string;
  accountId: string;
}

export const DEFAULT_SSH_HOST_TEMPLATE = "ssh-{pool}-jupyter.ai.cloud.ru";
export const DEFAULT_SSH_PORT = 2222;

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

/** Derive the GPU/region pool from a notebook URL prefix (`/a100-mt/notebook/…` → `a100`). */
export function sshPoolFromNotebookUrl(notebookUrl: string): string | undefined {
  const { prefix } = parseNotebookUrl(notebookUrl);
  const first = prefix.split("/").find((segment) => segment.length > 0);
  return first ? first.replace(/-mt$/i, "") : undefined;
}

/** Build the pool-specific SSH host from a template, or undefined when the pool can't be derived. */
export function deriveSshHost(notebookUrl: string, template = DEFAULT_SSH_HOST_TEMPLATE): string | undefined {
  const pool = sshPoolFromNotebookUrl(notebookUrl);
  return pool ? template.replace("{pool}", pool) : undefined;
}

export function buildUsername(serverName: string, accountId: string): string {
  return `${serverName}.${accountId}`;
}
