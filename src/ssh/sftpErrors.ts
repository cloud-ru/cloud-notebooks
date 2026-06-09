// Classify SFTP/SSH errors into a VS Code FileSystemError kind. Pure (no `vscode`) → unit-testable;
// the provider maps the kind onto the concrete `vscode.FileSystemError`.

export type SftpErrorKind =
  | "FileNotFound"
  | "NoPermissions"
  | "FileExists"
  | "Unavailable"
  | "Unknown";

// ssh2 SFTP protocol status codes.
const SFTP_STATUS: Record<number, SftpErrorKind> = {
  2: "FileNotFound", // NO_SUCH_FILE
  3: "NoPermissions", // PERMISSION_DENIED
  6: "Unavailable", // NO_CONNECTION
  7: "Unavailable", // CONNECTION_LOST
};

export function classifySftpError(error: unknown): SftpErrorKind {
  if (!error || typeof error !== "object") return "Unknown";
  const err = error as { code?: unknown; message?: unknown };

  if (typeof err.code === "number") {
    const mapped = SFTP_STATUS[err.code];
    if (mapped) return mapped;
  }
  const code = typeof err.code === "string" ? err.code.toUpperCase() : "";
  if (code === "ENOENT") return "FileNotFound";
  if (code === "EACCES" || code === "EPERM") return "NoPermissions";
  if (code === "EEXIST" || code === "ENOTEMPTY") return "FileExists";
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED") return "Unavailable";

  const message = typeof err.message === "string" ? err.message.toLowerCase() : "";
  if (message.includes("no such file")) return "FileNotFound";
  if (message.includes("permission denied")) return "NoPermissions";
  if (message.includes("already exists")) return "FileExists";
  return "Unknown";
}
