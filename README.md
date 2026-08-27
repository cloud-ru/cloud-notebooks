<div align="center">

# Cloud.ru Distributed Train Notebooks

**Work with Cloud.ru Distributed Train Jupyter Servers right inside VS Code and Cursor — no browser tab needed.**

Sign in to Cloud.ru, pick a workspace, browse your notebooks, open their web UI in an editor tab,
run cells on the remote cloud kernel, browse pod files over SSH, or go full Remote-SSH IDE.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.90-007ACC.svg?logo=visualstudiocode)](https://code.visualstudio.com/)
[![Cursor](https://img.shields.io/badge/Cursor-supported-4B0082.svg)](https://cursor.com)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522-339933.svg?logo=nodedotjs)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10-F69220.svg?logo=pnpm)](https://pnpm.io/)

[English](README.md) · [Русский](README.ru.md)

</div>

---

## Features

- **Cloud.ru sign-in via SSO** — no API keys, no OAuth app registration. The extension captures the
  same session token the web console uses.
- **Notebook explorer** for your workspace with live statuses, search by name, author/status
  filters, and favorites. Description editing is one command away.
- **Open the notebook web UI inside VS Code** — JupyterLab, marimo, code-server images and more,
  embedded through a local SSH tunnel + reverse proxy.
- **Remote kernels (Colab-style)** — notebook files run cells on the cloud kernel through the
  standard Jupyter extension's server picker.
- **Pod files over SSH/SFTP** — mount the notebook home folder right into the Explorer, with full
  copy/paste/rename/delete support.
- **Full IDE mode** — open the pod as a **Remote-SSH** window (the extension even pre-seeds the
  VS Code/Cursor server onto the pod so slow egress doesn't block you).
- **Lifecycle from the editor** — start/pause/delete notebooks with progress tracking and status
  polling; view logs inline or download them for the last 1/3/7 days.
- **SSH key management** — generate a key in Cloud.ru or upload your own public key.

## How it works

Sign in once with your Cloud.ru account (SSO in the browser). The extension lists your Jupyter
Server notebooks and manages their lifecycle, and connects to running notebooks over SSH — for the
embedded web UI, remote kernels, file browsing, and Remote-SSH.

## Getting started (development)

Requirements: Node.js ≥ 22, pnpm 10 (`corepack enable`), VS Code ≥ 1.90 / Cursor, and a local
Chrome/Chromium/Edge for the sign-in flow.

```bash
pnpm install
pnpm bundle:watch     # esbuild watch → dist/extension.js
# press F5 → "Run Extension"
```

In the Extension Development Host window: open the **Cloud.ru Distributed Train** view → **Sign In** →
**Select Workspace** → work with your notebooks.

```bash
pnpm test         # unit tests (vitest)
pnpm typecheck    # tsc --noEmit
pnpm bundle       # one-shot build
```

The full guide (packaging a `.vsix`, publishing, manual smoke checklist, diagnostics) lives in
[docs/development.md](docs/development.md).

## Commands

All commands are available from the Command Palette (`Cmd/Ctrl+Shift+P`, prefix "Cloud.ru:") and
from the `…` menu next to each notebook.

| Command | Action |
|---------|--------|
| Sign In / Sign Out | Sign in to / out of Cloud.ru |
| Select Workspace | Pick the workspace to browse |
| Refresh Notebooks | Re-fetch the notebook list |
| Open Notebook in VS Code | Embed the notebook web UI in an editor tab |
| Open Notebook in Browser | Open Jupyter/JupyterLab externally |
| Start / Pause Notebook | Resume / pause with live status polling |
| Show Logs | Inline logs + status reason |
| Download Logs… | Save logs from the last 1/3/7 days |
| Edit Description… | Change the description shown in the list and console |
| Browse Notebook Files (SSH) | Mount the pod home folder via SFTP |
| Open Full IDE (Remote-SSH) | Open the pod as a Remote-SSH window |
| Configure SSH / Get SSH Key / Upload Public SSH Key | Manage the Distributed Train SSH key |
| Search / Filter by Author / Filter by Status / Favorites | Filter the list |

## Settings

| Key | Default | Purpose |
|-----|---------|---------|
| `cloudru.console.apiBaseUrl` | `https://console.cloud.ru/aicloud/ui` | Console web API base URL |
| `cloudru.console.url` | `https://console.cloud.ru/` | Console URL opened for sign-in |
| `cloudru.notebook.chromePath` | *(auto-detect)* | Browser executable used for the one-time sign-in |
| `cloudru.ssh.privateKeyPath` | *(empty)* | Distributed Train private key (files, kernels, IDE) |
| `cloudru.ssh.host` | `ssh-jupyter.ai.cloud.ru` | Fallback gateway host when only an account id is given |
| `cloudru.ssh.port` | `2222` | Gateway port |

## Repository layout

```
src/            extension sources (api, auth, console, jupyter, ssh, views, commands)
test/unit/      vitest unit tests (network-free, injected fetch)
docs/           dev guide
esbuild.js      bundler config
package.json    extension manifest (commands, views, settings)
```

## Documentation

| Document | Contents |
|----------|----------|
| [docs/development.md](docs/development.md) | Dev workflow, tests, packaging, publishing |

## Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
Security issues: [SECURITY.md](SECURITY.md). Changes are tracked in
[CHANGELOG.md](CHANGELOG.md).

## License

[Apache-2.0](LICENSE)
