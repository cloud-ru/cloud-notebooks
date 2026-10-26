# Security Policy

## Supported versions

Security fixes are applied to the latest release on `main` and to the most recent published version.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Email [opensource@cloud.ru](mailto:opensource@cloud.ru) with the subject "Security: cloud-notebooks".
Alternatively, use GitHub's private vulnerability reporting when it is enabled for this repository
(Security tab → Report a vulnerability;
[how it works](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).

Include as much of the following as you can:

- The type of issue and its impact.
- Step-by-step reproduction instructions or a proof of concept.
- Affected versions/commits.
- Any potential workarounds you are aware of.

## What the extension stores locally

Understanding the extension's attack surface may help when reporting:

- **OIDC session token** — kept in memory only, re-minted from a persistent browser profile stored
  under the extension's global storage. Never written to logs (the logger redacts bearer tokens).
  The profile's cookies (the SSO session) are encrypted by the OS secret store (Keychain, libsecret or
  KWallet; DPAPI on Windows). While VS Code is open the session is refreshed in the background; this
  pauses after 8 hours without activity in VS Code.
- **Signed-in account fingerprint** — a SHA-256 of the token's issuer and subject in global state,
  used to reject a refreshed token issued to a different account. The user id itself is not stored.
- **Selected workspace id/name** — stored in VS Code SecretStorage.
- **SSH private key path and cached gateway endpoints/targets** — a configuration pointer in global
  settings plus non-secret endpoint metadata; key files themselves keep their on-disk permissions
  (generated keys are written with `0600`).
- **Network surface** — the extension talks to `console.cloud.ru/aicloud/ui`, `update.code.visualstudio.com`
  (or the fork-specific server CDN) during pre-seeding, and to user-configured SSH gateways. Locally it
  runs reverse proxies bound to `127.0.0.1` on ephemeral ports — one per opened notebook webview and
  one per notebook used as a remote Jupyter kernel server — that reach the pod's JupyterLab over SSH
  channels opened in-process; there is no other local listener. Every request must carry `Host` equal
  to the proxy's own address, an `Origin` (when present) equal to its own origin, must not be a
  cross-site non-navigation fetch (`Sec-Fetch-Site`), and must present a per-proxy 256-bit secret that
  is handed only to the notebook webview (HttpOnly cookie) or to the VS Code Jupyter extension (Jupyter
  `token`); anything else gets `403`. The secret never leaves the machine and is stripped before
  forwarding. The proxies stay up until the notebook is paused, resumed or deleted,
  "Подключиться снова" is pressed, you sign out or switch workspace, or VS Code exits — not only while
  the webview is open. They do not protect against processes running under your own OS user.

All `cloudru.*` settings are user-level (`application` scope), so a workspace's settings cannot
redirect the console API, the sign-in page, the browser executable, or the SSH key and gateway.

If you believe any of these boundaries can be crossed, we want to hear about it.
