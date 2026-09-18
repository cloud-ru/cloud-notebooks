import * as vscode from "vscode";

/** Single OutputChannel for the extension. Scrubs obvious secrets before writing. */
export class Logger {
  private readonly channel: vscode.OutputChannel;

  constructor(name = "Cloud.ru Distributed Train") {
    this.channel = vscode.window.createOutputChannel(name);
  }

  info(message: string): void {
    this.write("INFO", message);
  }

  warn(message: string): void {
    this.write("WARN", message);
  }

  error(message: string, err?: unknown): void {
    const detail = err instanceof Error ? `${err.message}` : err ? String(err) : "";
    this.write("ERROR", detail ? `${message} :: ${detail}` : message);
  }

  show(): void {
    this.channel.show(true);
  }

  private write(level: string, message: string): void {
    this.channel.appendLine(`${new Date().toISOString()} [${level}] ${scrubSecrets(message)}`);
  }

  dispose(): void {
    this.channel.dispose();
  }
}

/** Best-effort redaction so tokens/keys never land in the log. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi, "<private key redacted>")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1<redacted>")
    .replace(/([?&](?:access_token|refresh_token|token|client_secret|code|session|password|x-api-key)=)[^&#\s]+/gi, "$1<redacted>")
    .replace(/(\b(?:Authorization|Cookie|Set-Cookie)\s*[:=]\s*)[^\r\n]+/gi, "$1<redacted>")
    .replace(/("?(?:client_secret|x-api-key|access_token|refresh_token|password)"?\s*[:=]\s*)("?)[^",}\s]+\2/gi, "$1$2<redacted>$2");
}
