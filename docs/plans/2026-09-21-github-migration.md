# GitHub Migration Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking and are executed through `/pipeline`.

**Goal:** Make `https://github.com/cloud-ru/cloud-notebooks` the canonical repository, with pull requests and tagged releases validated and packaged by GitHub Actions.

**Architecture:** Preserve the existing Git history and mirror the proven GitLab CI contract in GitHub Actions: Node.js 22, pnpm 10.22.0, frozen dependencies, type checking, unit tests, bundling, and VSIX packaging. Keep one stable required check named `verify`; use a separate tag-only release workflow so normal pull requests never receive write permissions.

**Tech Stack:** Git, GitHub Actions, Node.js 22, pnpm 10.22.0, TypeScript, Vitest, esbuild, `@vscode/vsce` 3.9.2.

## Global Constraints

- Preserve the existing commit history and all code reachable from `main`.
- Do not include the pre-existing untracked `docs/audit-plan.md` in migration changes.
- Keep runtime dependencies inside the VSIX by installing with `node-linker=hoisted` and never passing `--no-dependencies` to `vsce`.
- Give pull-request workflows read-only repository permissions; grant `contents: write` only to the tag release job.
- Keep Node, pnpm, and VSCE versions aligned with the existing `.gitlab-ci.yml` pipeline.

---

### Task 1: GitHub Actions CI and release pipelines

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Delete: `.gitlab-ci.yml`
- Verify: `pnpm typecheck && pnpm test && pnpm bundle && pnpm dlx @vscode/vsce@3.9.2 package`

**Interfaces:**
- Consumes: `package.json#packageManager`, existing npm scripts, and `pnpm-lock.yaml`.
- Produces: required check `verify`, 14-day `cloud-notebooks-vsix` run artifacts, and GitHub Releases containing a `.vsix` for `v*` tags.

- [ ] **Step 1: Define the observable contract**

Expected: Every pull request and push to `main` installs the frozen lockfile, passes type checking and all unit tests, builds the extension, packages a VSIX, and uploads it for 14 days. Pushing a `v*` tag reruns the same gates and publishes the VSIX to a GitHub Release.

Proof: Parse both workflow files, run the exact local command above, and inspect the resulting VSIX file list.

- [ ] **Step 2: Implement the production change**

Create least-privilege Actions workflows with concurrency cancellation for superseded CI runs. Reuse the exact Node/pnpm/VSCE versions and hoisted install mode from `.gitlab-ci.yml`; remove the obsolete GitLab workflow.

- [ ] **Step 3: Exercise the changed surface**

Run: `pnpm typecheck && pnpm test && pnpm bundle && pnpm dlx @vscode/vsce@3.9.2 package`

Expected: every command exits 0 and a non-empty `cloudru-jupyter-vscode-0.1.0.vsix` is produced.

### Task 2: Canonical repository metadata and contributor documentation

**Files:**
- Modify: `package.json:24-31`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md:14-56`
- Modify: `docs/development.md:104-116`
- Verify: `rg -n "cloud-ru/cloudru-jupyter-vscode|cd ntb-vscodeextension|merge request|gitlab-ci" package.json README.md CONTRIBUTING.md docs/development.md`

**Interfaces:**
- Consumes: the new repository name `cloud-ru/cloud-notebooks` and workflow path `.github/workflows/ci.yml`.
- Produces: correct package metadata, clone instructions, pull-request terminology, CI badge, and development documentation.

- [ ] **Step 1: Define the observable contract**

Expected: All repository links, checkout instructions, and CI references point to the new GitHub repository and workflows.

Proof: The `rg` verification command returns no stale canonical repository or GitLab workflow references.

- [ ] **Step 2: Implement the production change**

Update `repository`, `homepage`, and `bugs` metadata; add the CI badge; change the clone directory and merge-request wording; document GitHub Actions as the packaging source.

- [ ] **Step 3: Exercise the changed surface**

Run: `pnpm typecheck` and the stale-reference `rg` command.

Expected: type checking exits 0 and the search has no matches.

### Task 3: Publish the preserved repository history

**Files:**
- Modify: local Git remote configuration only
- Verify: `git ls-remote origin refs/heads/main`

**Interfaces:**
- Consumes: the verified migration commit and access to `cloud-ru/cloud-notebooks`.
- Produces: GitHub `main` at the migration commit with all 44 existing commits plus the migration commit.

- [ ] **Step 1: Define the observable contract**

Expected: GitHub `main` resolves to the same commit as local `HEAD`; the previous GitLab remote remains available as `gitlab` for traceability.

Proof: Compare `git rev-parse HEAD` with `git ls-remote origin refs/heads/main`.

- [ ] **Step 2: Implement the production change**

Commit only the migration files, rename current `origin` to `gitlab`, add `origin` as `https://github.com/cloud-ru/cloud-notebooks.git`, and push local `main` with upstream tracking.

- [ ] **Step 3: Exercise the changed surface**

Run: `git push -u origin main`, then `git ls-remote origin refs/heads/main`.

Expected: the push succeeds and both commands report the local `HEAD` commit.
