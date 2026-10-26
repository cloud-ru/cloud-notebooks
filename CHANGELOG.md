# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- The local proxies for the notebook webview and the remote kernel now require a per-session secret
  and reject requests with a foreign `Host` or `Origin` or cross-site fetch metadata, and the
  unauthenticated raw SSH port-forwards are gone. Previously any web page or local process that found
  the random port could reach the pod's JupyterLab API without credentials.
- `SECURITY.md` now documents this local trust boundary and names e-mail as the primary channel for
  reporting vulnerabilities.

## [0.1.2] - 2026-10-16

### Added

- Background session keep-alive: the console token is re-minted silently when it falls due, whether
  or not the window is focused, so the Cloud.ru SSO session no longer idles out while VS Code is open
  and API calls rarely wait on a headless browser. Transient failures (offline, busy browser profile)
  retry with back-off instead of signing out. Pauses after 8 hours without activity in VS Code, so an
  unattended machine still lets the session time out. Controlled by
  `cloudru.console.keepSessionAlive` (on by default).

### Security

- The sign-in browser profile now keeps its cookies (the Cloud.ru SSO session included) in the OS
  secret store — Keychain, libsecret or KWallet — instead of puppeteer's mock keychain, which
  encrypted them with a fixed, publicly known key. Cookies saved by earlier versions are deleted once,
  so macOS and Linux users sign in again once after updating (the prompt says why). Windows already
  used DPAPI and is unaffected.
- All `cloudru.*` settings are now user-level only (`application` scope): a repository's
  `.vscode/settings.json` can no longer point the console API (and the token sent to it), the sign-in
  page, the browser executable, or the SSH key and gateway somewhere else.
- Silent token refreshes accept only a token for the account the user signed in with, and prefer the
  console's own cookie over one set on a parent domain, so a cookie planted by another `*.cloud.ru`
  site cannot switch the extension to a different account.

### Fixed

- "Открыть в VS Code", remote kernels and "Открыть в браузере" no longer fail with `Invalid URL`
  when the backend returns the notebook URL as a bare host without a scheme (new format).
- An expired session no longer leaves the Notebooks view stuck on "Загружаем ноутбуки…" with nothing
  clickable: the view shows "Сессия Cloud.ru истекла" with a sign-in button, the view title gets a
  «Войти» button, and the status bar shows "Cloud.ru: войдите снова".
- "Выполняется вход в Cloud.ru…" no longer flashes over an already loaded list on a token refresh.
- Clicking «Войти» again while the sign-in browser window is open no longer opens a second window.

## [0.1.1] - 2026-09-25

### Changed

- Distribute versioned VSIX files through GitHub Releases.

## [0.1.0] - 2026-08-27

First public-ready release of the extension.

### Added

- Notebook explorer for the active workspace: live statuses, search by name, author/status filters,
  favorites, and a status-bar workspace switcher.
- Embedded notebook web UI: the pod's JupyterLab (or marimo/code-server) is reached over an SSH
  tunnel, framed in a webview through a local reverse proxy that strips only framing headers.
- Remote kernels (Colab-style): running notebooks are contributed to the Jupyter extension as
  servers tunneled over SSH; cells execute on the cloud kernel.
- Pod file browsing over SFTP with full create/copy/rename/delete support.
- Full IDE mode via any Remote-SSH-compatible extension (VS Code, Cursor forks included), with a
  best-effort pre-seed of the matching VS Code/Cursor server build onto the pod so throttled pod
  egress does not block the first connect.
- Lifecycle commands: pause, resume, and delete, each tracked by a cancellable status poll that
  feeds the tree live.
- Description editing and auto-shutdown state surfaced in tooltips.
- Log viewing inline plus log download for the last 1/3/7 days.
- SSH key management: generate a key via Cloud.ru or upload your own public key.
- Warning indicators in tooltips: scheduled pod restarts and failed S3 bucket mounts.
- Sign-in via browser SSO with persistent profile; silent token re-mint on expiry and a single
  "session expired → sign in" recovery path.
- Resilience: HTTP timeouts, 401 re-mint-and-retry, deduped concurrent list fetches, stale-tunnel
  detection before reuse, typed API errors with Retry-After parsing.

### Fixed

- Live WebSocket/kernel sockets are now destroyed when tunnels or the shim are disposed instead of
  keeping handles open after pause/resume or sign-out.
- Explorer copy/paste works inside the SFTP provider (recursive `copy` implementation); moving files
  between two different notebooks is rejected explicitly instead of misbehaving.
- Transient notebook statuses show an accurate "status transition in progress" reason in action
  menus rather than a misleading "not running".

[Unreleased]: https://github.com/cloud-ru/cloud-notebooks/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/cloud-ru/cloud-notebooks/releases/tag/v0.1.2
