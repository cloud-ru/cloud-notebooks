# Cloud.ru ML Space Notebooks — VS Code extension

Sign in to Cloud.ru, browse the **Jupyter Server notebooks** created in the Cloud.ru ML Space console,
and **open them directly in VS Code** — instead of opening JupyterLab in a browser tab.

> Status: sign-in, workspace selection, and the notebook list work end-to-end. **Opening the notebook
> UI inside VS Code** is implemented via a one-time login capture + a local shim that frames JupyterLab
> (the notebook proxy blocks tokens and iframing, so this is the viable path — see
> `docs/development.md` §9). Interactive flow needs live verification in the dev host.

## What it does (target)
- **Sign in to Cloud.ru** from inside VS Code (service-account Access Key; see `docs/decisions.md` D1).
- **Pick a workspace** and see your notebooks with live status.
- **Open a notebook in VS Code**: edit the remote `.ipynb` files and run cells on the remote kernel.
- Fallbacks: open in browser, resume a paused notebook, pause a running one.

## Start here (for implementers)
1. `PLAN.md` — the implementation plan: architecture, modules, phases, acceptance criteria, risks.
2. `docs/api-contract.md` — the exact Cloud.ru endpoints, DTOs, headers, and the auth flow (grounded
   in the OpenAPI spec).
3. `docs/decisions.md` — locked decisions + open questions to resolve with the team.
4. `docs/reference/mlspace-public-api.openapi.json` — authoritative ML Space public API (v2.7.0).
5. `docs/reference/vscode-jupyter-api.d.ts` — authoritative VS Code Jupyter extension API.

## How "open in VS Code" works (summary)
The extension contributes two surfaces to the VS Code Jupyter ecosystem:
- a **Jupyter Server provider** (`createJupyterServerCollection`) that exposes each running notebook as
  a remote kernel source, authenticating to the Cloud.ru proxy via connection `headers`;
- a **FileSystemProvider** (`cloudru-jupyter://`) backed by each notebook's Jupyter **Contents API**, so
  the remote files show up and open natively.

The notebook image runs JupyterLab with no token (`--NotebookApp.token=''`); access is gated by the
Cloud.ru portal/auth-proxy in front of the notebook `url`. Confirming exactly what that proxy accepts
is the #1 verification item — see `PLAN.md` §11.

## Dev quickstart
```bash
pnpm install
pnpm bundle:watch      # esbuild watch → dist/extension.js
pnpm test              # unit tests (vitest)
pnpm typecheck         # tsc --noEmit
# Press F5 → "Run Extension" (see .vscode/launch.json)
```
Full build / dev-host / packaging / Marketplace publishing instructions: **`docs/development.md`**.

## Layout
```
PLAN.md                 implementation plan / handoff
package.json            extension manifest (commands, views, settings)
esbuild.js              bundler
src/                    extension source (auth, api, session, views, commands)
test/unit/              vitest unit tests
docs/
  development.md        build / dev / test / publish guide
  api-contract.md       grounded Cloud.ru API reference
  decisions.md          decisions + open questions
  reference/            authoritative specs (OpenAPI, VS Code Jupyter API types)
```

## License
Apache-2.0.
