// Pure helper for the local kernel base URL. No `vscode` → unit-testable.

/**
 * Build the Jupyter base URL the VS Code Jupyter extension connects to: the local shim's base URL
 * (`http://127.0.0.1:<port>`, no trailing slash) plus the pod's `base_url` prefix (e.g.
 * `/a100-mt/notebook/<uuid>/`). Guarantees a single leading and trailing slash on the prefix so REST
 * paths like `<base>api/kernels` resolve correctly.
 */
export function buildKernelBaseUrl(baseUrl: string, prefix: string): string {
  let path = prefix.trim();
  if (!path.startsWith("/")) path = `/${path}`;
  if (!path.endsWith("/")) path += "/";
  return `${baseUrl}${path}`;
}
