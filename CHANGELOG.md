# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-10-16

### Fixed

- "Открыть в VS Code", remote kernels and "Открыть в браузере" no longer fail with `Invalid URL`
  when the backend returns the notebook URL as a bare host without a scheme (new format).

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
