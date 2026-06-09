// Pure helper for the local kernel base URL. No `vscode` → unit-testable.

/**
 * Build the Jupyter base URL the VS Code Jupyter extension connects to: the locally-forwarded port
 * plus the pod's `base_url` prefix (e.g. `/a100-mt/notebook/<uuid>/`). Guarantees a single leading and
 * trailing slash on the prefix so REST paths like `<base>api/kernels` resolve correctly.
 */
export function buildKernelBaseUrl(localPort: number, prefix: string): string {
  let path = prefix.trim();
  if (!path.startsWith("/")) path = `/${path}`;
  if (!path.endsWith("/")) path += "/";
  return `http://127.0.0.1:${localPort}${path}`;
}
