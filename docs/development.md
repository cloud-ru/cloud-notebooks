# Development, testing & publishing

How the extension goes from source → running in VS Code → installed for QA → published.

## 0. Prerequisites
- Node.js ≥ 18 (this repo is built/tested on Node 20/24).
- **pnpm** — this project uses pnpm (pinned via `packageManager` in `package.json`). The simplest way
  to get the right version is Corepack: `corepack enable` (ships with Node), or install pnpm directly
  (`npm i -g pnpm` / `brew install pnpm`).
- VS Code ≥ 1.90.
- For packaging/publishing: `@vscode/vsce` (Marketplace) and optionally `ovsx` (Open VSX). Run via
  `pnpm dlx` — no global install needed.
- A Cloud.ru **service account** with an **Access Key** (`client_id` + `client_secret`) created in the
  Cloud.ru console (Management → service accounts → access keys).

> pnpm note: pnpm 10 blocks dependency build scripts by default. `esbuild`'s postinstall is
> allow-listed via `pnpm.onlyBuiltDependencies` in `package.json`, so a fresh `pnpm install` links the
> esbuild binary correctly. If you add a dependency that needs its install script, add it there.

## 1. Install & build
```bash
pnpm install
pnpm bundle           # one-off esbuild → dist/extension.js
pnpm bundle:watch     # rebuild on change (use while developing)
```
- `dist/extension.js` is the bundled entry point declared by `package.json#main`. It is gitignored and
  rebuilt on demand (and automatically before packaging via `vscode:prepublish`).
- `pnpm typecheck` runs `tsc --noEmit` (esbuild itself does not type-check).

## 2. Run in dev mode (Extension Development Host)
This is the inner loop — no packaging required.

1. Open this folder in VS Code.
2. Start `pnpm bundle:watch` (or rely on the `preLaunchTask`).
3. Press **F5** (launch config "Run Extension" in `.vscode/launch.json`). A second VS Code window
   opens — the **Extension Development Host** — with this extension loaded.
4. In that window:
   - Open the **Cloud.ru ML Space** view from the activity bar.
   - Click **Sign in to Cloud.ru** → paste `client_id`, then `client_secret`. The keys are stored in
     VS Code **SecretStorage** (OS keychain), never in settings or logs.
   - Pick a workspace → the notebook list loads. Each row shows status; the inline / context action
     **Open in Browser** opens today's Jupyter URL.
5. Inspect logs in **Output → "Cloud.ru ML Space"**. Secrets are scrubbed.
6. After code changes: the watcher rebuilds; press **Ctrl/Cmd+R** in the dev-host window to reload, or
   use *Developer: Reload Window*.

> Tip: `ms-toolsai.jupyter` is a runtime dependency for the *next* phase (open-in-VS-Code). It is not
> required for the auth + listing slice. When you add the kernel/FS providers, add
> `"extensionDependencies": ["ms-toolsai.jupyter"]` back to `package.json` and `@vscode/jupyter-extension`
> to devDependencies.

## 3. Testing
- **Unit (vitest, no VS Code):** `pnpm test`. Covers the API client (header/query construction, error
  mapping, network failures), error mapping, token cache expiry, and status presentation. These run in
  CI and locally in milliseconds because the `vscode`-coupled code is kept out of the tested modules
  (the client takes an injectable `fetchImpl`).
- **Integration (future, `@vscode/test-electron`):** launches a headless VS Code to assert activation,
  command registration, and tree rendering against a faked client. Add under `test/integration/`.
- **Live API smoke (manual / opt-in):** gate behind env vars and skip when absent — never commit keys:
  ```bash
  CLOUDRU_CLIENT_ID=... CLOUDRU_CLIENT_SECRET=... pnpm smoke   # script to be added
  ```

## 4. Package a VSIX (shareable build)
```bash
pnpm dlx @vscode/vsce package   # → cloudru-jupyter-vscode-0.0.1.vsix
```
- `vsce` runs `vscode:prepublish` (production bundle) first.
- Do **not** pass `--no-dependencies`: `puppeteer-core` is a real runtime `dependency` marked
  `external` in esbuild (it is too heavy/dynamic to bundle), so it must ship in `node_modules`. vsce
  includes `dependencies` (not `devDependencies`) automatically. `http-proxy` is bundled into
  `dist/extension.js`, so only `puppeteer-core` is shipped unbundled.
- Requires a Chrome/Chromium/Edge on the user's machine for the one-time notebook sign-in (auto-detected,
  or set `cloudru.notebook.chromePath`). The extension does not bundle a browser.
- Engine note: the embedded-notebook code uses `Promise.withResolvers`, which needs the Node runtime
  shipped with VS Code ≥ the version whose Electron carries Node 22 (recent VS Code). Bump
  `engines.vscode` if you must support older builds.
- Warnings you may see and how to clear them: add a `LICENSE` file, a `README.md` (present), an `icon`
  (128×128 PNG referenced by `package.json#icon`), and a `repository` (present). Warnings are
  non-fatal; `--allow-*` flags exist if you must skip one.

### Install/sideload the VSIX (for QA or internal distribution)
```bash
code --install-extension cloudru-jupyter-vscode-0.0.1.vsix
```
or in VS Code: Extensions view → "…" menu → **Install from VSIX…**. This is the simplest way to hand a
build to colleagues without using a public marketplace.

## 5. Publish to the VS Code Marketplace
The Marketplace is backed by Azure DevOps.

1. **Create a publisher** at <https://marketplace.visualstudio.com/manage> (the `publisher` field in
   `package.json` must match — currently `cloudru`).
2. **Create a Personal Access Token (PAT)** in Azure DevOps for that org with scope **Marketplace →
   Manage**.
3. **Authenticate & publish:**
   ```bash
   pnpm dlx @vscode/vsce login cloudru                     # paste the PAT once
   pnpm dlx @vscode/vsce publish --no-dependencies         # publishes the current version
   # or bump + publish in one step:
   pnpm dlx @vscode/vsce publish patch --no-dependencies   # 0.0.1 → 0.0.2 (also: minor / major / <version>)
   ```
4. **Pre-publish requirements:** unique `name`+`publisher`, a `displayName`, `description`, `engines.vscode`,
   `categories`, a 128×128 `icon`, a `README.md` (shown on the listing), a `LICENSE`, and a
   `repository` URL. CI should run `typecheck` + `test` + `package` before publishing.
5. **Versioning:** Marketplace rejects re-publishing the same version — always bump. Use
   `--pre-release` for preview channels.

## 6. Open VSX (optional — for VSCodium / Cursor / non-Microsoft builds)
```bash
pnpm dlx ovsx publish cloudru-jupyter-vscode-0.0.1.vsix -p <OPEN_VSX_TOKEN>
```
Recommended if any users run a VS Code derivative that cannot reach the MS Marketplace.

## 7. Internal-only distribution (likely the right default for an enterprise rollout)
If this should not be public:
- Distribute the **VSIX** via an internal artifact store / shared drive and have users sideload (§4).
- Or host a **private extension gallery** (e.g. an internal Open VSX, or a service like Eclipse Open
  VSX self-hosted) and point users' `extensions.gallery` settings at it.
- A CI job can build the VSIX on tag and publish it to the chosen channel.

## 8. Suggested CI (GitHub Actions / GitLab CI)
On push/PR: `pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm test` → `pnpm package`
(artifact the `.vsix` via `pnpm dlx @vscode/vsce package`).
On tag `v*`: additionally `vsce publish` (and/or `ovsx publish`) using a secret PAT. Use
`corepack enable` (or `pnpm/action-setup`) so CI picks up the pinned pnpm version.

## 9. Embedded notebook UI (web UI inside VS Code) — how it works & how to verify

The notebook web UI lives behind a Cloud.ru OIDC proxy that (a) refuses every API token we can mint
(only its interactive `authservice_session` cookie authenticates) and (b) sets `X-Frame-Options: DENY`
/ `CSP frame-ancestors 'self'`. So the extension:
1. **Captures the session** — `cloudru.openNotebook` opens a controlled browser (`puppeteer-core` +
   system Chrome) at the notebook URL; you complete the normal cloud.ru login; the extension reads the
   `authservice_session` cookie via CDP and stores it in SecretStorage (per host).
   (`src/jupyter/oidcLogin.ts`, `src/jupyter/sessionCookies.ts`)
2. **Runs a local shim** — a `127.0.0.1` reverse proxy that injects the session cookie on every
   request, proxies HTTP + WebSocket to the notebook origin, strips `X-Frame-Options`, removes CSP
   `frame-ancestors`, and rewrites Set-Cookie (drops `Secure`/`Domain`) so cookies persist over
   `http://127.0.0.1`. (`src/jupyter/shim.ts`, `src/jupyter/headerRewrite.ts`)
3. **Frames it** — a webview editor iframes `http://127.0.0.1:<port>/<prefix>/lab`, so JupyterLab
   renders inside VS Code. (`src/jupyter/notebookPanel.ts`, orchestrated by
   `src/jupyter/notebookController.ts`)

The deterministic core (header/cookie/URL transforms) is unit-tested. The interactive path can only be
verified live in the Extension Development Host:
1. `pnpm bundle` → F5. Sign in, select workspace, click a **running** notebook.
2. A browser window opens → log in to cloud.ru → it closes; a webview editor opens with the lab.
3. Confirm: the file tree loads, open a notebook, run a cell → output returns (kernel WS rides the
   shim). If the lab shows a login redirect instead, the session expired → reopen to re-login.

Verification notes / risks to watch:
- **WebSocket**: kernels need the WS upgrade to proxy through the shim — confirm cells execute.
- **PageConfig wsUrl**: if the lab tries to open `wss://k2-nb…` directly (bypassing the shim) instead
  of a relative URL, the shim must also rewrite the HTML `PageConfig`. Modern JupyterLab derives the WS
  URL from `window.location`, so this usually works as-is; verify on the target image.
- **Session lifetime**: when `authservice_session` expires the shim detects the OIDC redirect and
  clears it; the next open re-runs the login.