# Security Policy

## Supported versions

Security fixes are applied to the latest release on `main` and to the most recent published version.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use [GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/private-reporting-a-vulnerability)
for this repository, or contact the maintainers through Cloud.ru's official channels.

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
  (or the fork-specific server CDN) during pre-seeding, and to user-configured SSH gateways. A local
  reverse proxy binds strictly to `127.0.0.1` only while a notebook webview is open.

All `cloudru.*` settings are user-level (`application` scope), so a workspace's settings cannot
redirect the console API, the sign-in page, the browser executable, or the SSH key and gateway.

If you believe any of these boundaries can be crossed, we want to hear about it.
