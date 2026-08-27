# Contributing

Thanks for your interest in improving **Cloud.ru Distributed Train Notebooks**! This document describes the
development workflow and project conventions.

## Requirements

- Node.js ≥ 22 and pnpm 10 (enable via `corepack enable`, or see
  [docs/development.md](docs/development.md#требования))
- VS Code ≥ 1.90 or a compatible fork (Cursor, VSCodium)
- A local Chrome/Chromium/Edge executable for the sign-in flow

## Getting started

```bash
git clone <your-fork-url>
cd ntb-vscodeextension
pnpm install
pnpm bundle:watch   # in one terminal — rebuilds dist/extension.js on change
```

Press **F5** in another terminal/IDE window to launch the *Extension Development Host* and try your
changes. The full walkthrough lives in [docs/development.md](docs/development.md).

Before pushing, make sure the verification suite passes:

```bash
pnpm typecheck   # tsc --noEmit (esbuild does not check types)
pnpm test        # vitest unit suite
pnpm bundle      # a clean production-shaped bundle
```

## Project conventions

- **Pure, testable core.** Any logic that does not need the `vscode` API lives in a module without a
  `vscode` import (mappers, URL/header/error helpers, polling loops) and gets unit tests with an
  injected `fetchImpl`. Look at `src/console/*` and `test/unit/*` for established patterns — copy the
  nearest existing pattern instead of inventing a new one.
- **Console API contracts.** When adding or changing an endpoint, follow the exact URL, headers
  (`Authorization: Bearer`, `x-workspace-id`) and payload shapes already used in `src/console/`.
- **Errors are loud and typed.** Throw `ApiError` (with its kind) from the API layer; do not swallow
  exceptions into logs or fallbacks. UI surfaces errors through the shared `withErrorHandling`
  wrapper in `src/commands/index.ts`.
- **UI strings** shown to users are Russian (matching the web console), kept out of pure modules so
  they remain unit-testable.
- Keep diffs minimal: no speculative abstractions, no commented-out code.

## Submitting changes

1. Fork the repository and create a feature branch from `main`.
2. Make your change, including tests for any new logic.
3. Run `pnpm typecheck && pnpm test && pnpm bundle`.
4. If your change affects user-visible behavior, add the manual smoke checklist results from
   [docs/development.md](docs/development.md#ручной-smoke-чек-лист-extension-development-host) to the
   pull request description.
5. Open a merge request with a short summary of what changed and why.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) style
(`feat:`, `fix:`, `docs:`, …).

For notable user-facing changes, add an entry under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md).

## Reporting issues

Please include: VS Code/Cursor version, extension version, relevant lines from the
**Output → Cloud.ru Distributed Train** channel (secrets are redacted automatically), and the steps to
reproduce. For security issues, use the process in [SECURITY.md](SECURITY.md) instead of a public
issue.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache-2.0 license](LICENSE) that covers this project.
