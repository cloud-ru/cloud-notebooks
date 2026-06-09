# Plan — Remote filesystem for notebooks over SSH (browse files "as if connected via SSH")

Status: **plan only** (no code yet). Goal: after selecting a running notebook, show its filesystem in
VS Code's Explorer and let the user browse/open/edit files — the SSH-style experience — backed by the
ML Space SSH access that the platform already provides.

> Why SSH and not the HTTP path: the notebook web UI sits behind the OIDC proxy (only the
> `authservice_session` cookie authenticates; tokens are rejected). **SSH is a separate, key-authed
> channel that bypasses OIDC entirely** — clean, programmatic, no browser. It is exactly the right
> transport for a file browser.

---

## 1. Grounded facts (from cloud.ru docs)

Source: *Подключиться к Jupyter Server по SSH* and *Посмотреть ключи для работы с платформой*.

- **Connection shape** (validated against a real server's SSH dialog):
  `ssh my-notebook-server.ai0000000-00000@ssh-a100-jupyter.ai.cloud.ru -p 2222 -i <private_key>`
  - `<server-name>` = the Jupyter Server name **verbatim from the API** `NotebookHandlerResponse.name`
    (incl. the auto-generated suffix, e.g. `my-notebook-server`).
  - `<account-id>` = an auto-generated id (e.g. `ai0000000-00000`). **Not in the public API** — comes
    from the per-server SSH dialog. Treat it as captured from the user's pasted command and cached
    (per workspace, to be safe); do not hardcode/assume it.
  - **Host is pool/region-specific:** `ssh-<pool>-jupyter.ai.cloud.ru`. Real example `a100` →
    `ssh-a100-jupyter.ai.cloud.ru`; docs also show `ssh-sr002-jupyter` and the plain `ssh-jupyter`.
    The `<pool>` matches the lab URL path prefix (`…/a100-mt/notebook/…` → `a100`). Resolve from the
    notebook `region`/prefix, or simply take the host from the pasted command.
  - **Port `2222`.**
- **Auth = a per-user private key** ("Единый SSH Key"), downloaded once from the console
  (Jupyter Servers → ⋮ → SSH → "Скачать приватный ключ"). One key per user, reused for all servers. No
  public-API endpoint exposes it → the user must supply it (file path or `ssh-agent`).
  - Docs warn the SSH-agent may offer the **wrong** remembered key (`killall ssh-agent`). So prefer an
    **explicit `privateKey`** in `ssh2` over agent auth to avoid mis-auth; key file should be `chmod 600`.
- **Older keys are RSA**: connecting may require `HostkeyAlgorithms=+ssh-rsa` and
  `PubkeyAcceptedKeyTypes=+ssh-rsa`. The SSH client must offer `ssh-rsa`.
- **Remote home is `/home/jovyan`** (confirmed by the docs' `remote.SSH.serverInstallPath` example
  `/home/jovyan/.my-very-own-vscode-server`).
- **Image requirement**: `cr.ai.cloud.ru/aicloud-jupyter/jupyter-server` ≥ 0.0.90, JupyterLab. SSH only
  to a **running** server.
- The platform **already documents VS Code Remote-SSH** ("Add New SSH Host…", "Remote-SSH: Connect to
  Host…") against this endpoint, with a multi-user `serverInstallPath` caveat.

---

## 2. Two approaches

### Approach S — SFTP-backed `FileSystemProvider` (RECOMMENDED)
Open SSH+SFTP to the gateway with the user's key (via `ssh2`), implement a
`vscode.FileSystemProvider`, mount `/home/jovyan` as a workspace folder. Browse/open/edit happens in
the **current window**, no `vscode-server` install on the pod.
- ➕ Lightweight, in-window, matches "просмотр файлов"; key-auth only; no Remote-SSH dependency; no
  server install on the pod; full control over UX (tie into the existing notebook tree).
- ➖ We implement the FS ops + connection management; IntelliSense/extensions run locally (the remote is
  a virtual FS, not a remote dev host); `watch` is best-effort.

### Approach R — Native Remote-SSH handoff (optional, power-user)
Generate/merge an SSH config entry and invoke `ms-vscode-remote.remote-ssh` to open the remote folder.
- ➕ Full remote dev (terminal, remote extensions, IntelliSense on the pod); platform-documented;
  little custom file code.
- ➖ Installs `vscode-server` on the pod (needs egress/glibc; image ≥ 0.0.90); opens a **new window**;
  heavier; `remote.SSH.serverInstallPath` collision for multi-user workspaces; depends on the
  Remote-SSH extension being installed.

**Decision:** build **Approach S** as the primary feature (it is what was asked — browse files in
VS Code, SSH-style). Offer **Approach R** later as a one-click "Open full SSH session" command for users
who want a remote terminal/dev host (near-free to wire, leverages the documented flow).

---

## 3. Architecture (Approach S)

```
Notebook tree item ──"Open Files (SSH)"──► SshFsController
   ├── SshConfigStore        : private key (path/agent) + accountId + host/port template (SecretStorage/settings)
   ├── SshConnectionPool     : ssh2 Client + SFTP per notebook (lazy connect, keepalive, reconnect)
   ├── CloudruSshFsProvider  : vscode.FileSystemProvider over SFTP  (scheme: cloudru-ssh)
   └── mount: workspace.updateWorkspaceFolders → cloudru-ssh://<auth>/home/jovyan  (shown in Explorer)
```

### Modules (proposed)
```
src/ssh/
  sshConfig.ts        // capture/store key + accountId; resolve host/port/username per notebook
  connectionPool.ts   // ssh2 Client + SFTP lifecycle per authority (connect, keepalive, reconnect, dispose)
  sftpFs.ts           // CloudruSshFsProvider implements vscode.FileSystemProvider
  sftpErrors.ts       // map SFTP/SSH errno → vscode.FileSystemError (pure, unit-testable)
  sshUrl.ts           // pure: build username `<name>.<accountId>`, resolve region→host, parse a pasted ssh command
  (phase 3) terminal.ts  // ssh2 shell() ↔ vscode.Pseudoterminal
```

### URI scheme
`cloudru-ssh://<authority>/<absolute-remote-path>` where `<authority>` encodes the notebook (use the
notebook `uid`, sanitized). The controller maps authority → `{ host, port, username, keySource }`.

### FileSystemProvider → SFTP mapping
| VS Code method      | SFTP call                          | notes |
|---------------------|------------------------------------|-------|
| `stat`              | `lstat` (then `stat` for symlinks) | type/size/mtime/ctime; `FileType.SymbolicLink` flag |
| `readDirectory`     | `readdir`                          | map longname/attrs → `FileType` |
| `createDirectory`   | `mkdir`                            | |
| `readFile`          | `readFile` / stream                | return `Uint8Array` |
| `writeFile`         | `open`+`write`/`writeFile`         | honor `{create, overwrite}` flags → FileExists/FileNotFound |
| `delete`            | `unlink` / recursive `rmdir`       | `{recursive}` |
| `rename`            | `rename` (or remove+rename)        | honor `{overwrite}` |
| `copy` (optional)   | server-side `cp` via `exec` or stream | |
| `watch`             | no-op Disposable (phase 1)         | optional polling for changed dirs in phase 2 |

Error mapping (`sftpErrors.ts`, pure): `ENOENT/SSH_FX_NO_SUCH_FILE`→`FileNotFound`,
`EACCES/PERMISSION_DENIED`→`NoPermissions`, `EEXIST`→`FileExists`, else generic.

### Connection management
- One `ssh2.Client` + one long-lived `SFTPWrapper` per authority, created lazily on first FS op.
- `ssh2` connect config:
  - `host`, `port: 2222`, `username`.
  - `privateKey` (read from configured path) **or** `agent: process.env.SSH_AUTH_SOCK` when using ssh-agent; optional `passphrase`.
  - `algorithms.serverHostKey: ["ssh-ed25519","rsa-sha2-512","rsa-sha2-256","ssh-rsa"]` and allow `ssh-rsa` pubkey (RSA fallback per docs).
  - `hostVerifier`: TOFU — store the gateway host key on first connect (globalState), verify thereafter; surface a trust prompt.
  - `keepaliveInterval` (~20s); reconnect with backoff on drop; serialize the connect (one in-flight).
- Dispose all clients on deactivate / unmount.

---

## 4. Inputs & configuration (one-time "Configure SSH")

The two things not in the API — the **private key** and the **account-id** — are captured once and
cached:
- **`cloudru.ssh.privateKeyPath`** (setting) or a file picker; alternatively **use ssh-agent** when
  `SSH_AUTH_SOCK` is set (`ssh-add ./mlspace.private_key`). Optional `cloudru.ssh.passphrase` (SecretStorage).
- **account-id**: best UX — "Paste your SSH command" once (from the console SSH dialog for any server);
  `sshUrl.ts` parses `user@host -p port`, extracting `accountId` (the part after the first `.` in the
  user) and confirming `host`/`port`. Store `accountId` (workspaceState/secret). Username per notebook =
  `<notebook.name>.<accountId>`.
- **host**: setting `cloudru.ssh.hostTemplate` default `ssh-jupyter.ai.cloud.ru`, with optional
  `{region}` → `ssh-{region}-jupyter.ai.cloud.ru`. Resolve from `notebook.region` once the mapping is
  confirmed; the pasted command also reveals the exact host.
- **port**: setting `cloudru.ssh.port` default `2222`.
- **remote root**: setting `cloudru.ssh.remotePath` default `/home/jovyan`.

The private key and passphrase are secrets → never log; store the key path (not contents) in settings,
read at connect; keep passphrase in SecretStorage.

---

## 5. UX
- New inline action on a **running** notebook tree item: **"Open Files (SSH)"** (`$(folder-opened)`),
  command `cloudru.openNotebookFiles`.
- First run → "Configure SSH" quick flow (key + paste-command). Subsequent runs reuse the config.
- On success → add a workspace folder named after the notebook → Explorer shows the remote tree; user
  opens/edits files; saves go back over SFTP.
- A status item / context value showing "connected / reconnecting / disconnected".
- (Phase 3) **"Open SSH Terminal"** and **"Open as Remote-SSH window"** (Approach R) as extra actions.

---

## 6. Phasing (each phase verifiable)

**Phase 1 — read/browse + open/save (MVP).**
`sshConfig` capture, `connectionPool`, `CloudruSshFsProvider` (stat/readDirectory/readFile/writeFile),
mount command, error mapping. *Acceptance:* select a running notebook → "Open Files (SSH)" → `/home/jovyan`
lists in Explorer; open a file, edit, save → persists (verify via the lab/terminal).

**Phase 2 — full FS parity + resilience.**
createDirectory/delete/rename/new-file, overwrite semantics, reconnect/keepalive, multi-notebook,
basic change refresh, status indicator. *Acceptance:* create/rename/delete from Explorer reflect on the
server; dropped connection auto-recovers.

**Phase 3 — terminal + Remote-SSH handoff (optional).**
`ssh2` shell ↔ `Pseudoterminal` integrated terminal; "Open as Remote-SSH window" wiring (config +
`serverInstallPath` note). *Acceptance:* terminal runs commands on the pod; Remote-SSH opens the folder.

---

## 7. Dependencies
- **`ssh2`** (SSH/SFTP client, pure-JS with optional native `cpu-features`). Add as a runtime
  `dependency`; mark **external** in esbuild (like `puppeteer-core`) so optional native bits aren't
  bundled; ships in `node_modules`. `@types/ssh2` as devDep.
- Pure modules (`sshUrl`, `sftpErrors`) unit-tested; SFTP/connection are integration-verified in the
  dev host (cannot be exercised here).

---

## 8. Risks & verification (resolve before/while coding)

**Go/no-go test (run first, decides the whole approach):** with the downloaded key,
```bash
sftp -P 2222 -o HostkeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa \
  -i ./mlspace.private_key <name>.<accountId>@ssh-jupyter.ai.cloud.ru
sftp> ls /home/jovyan
```
If `sftp` lists files → Approach S is fully viable (FileSystemProvider over SFTP). If only `ssh` (no
sftp subsystem) works → fall back to exec-based file ops (`ls`/`cat`/`tee`), uglier; reassess.

Other items to confirm:
1. **Region → SSH host** mapping for the target notebook (`ssh-jupyter` vs `ssh-<region>-jupyter`). The
   pasted SSH command gives the exact host; templatize.
2. **Username format** `<name>.<accountId>` exact; capture `accountId` from the pasted command.
3. **Key source**: per-user vs per-workspace (docs say per-user; troubleshooting hints per-workspace —
   allow re-supply per workspace).
4. **RSA algorithms** accepted by `ssh2` handshake; include `ssh-rsa`.
5. **Gateway session stability**: long-lived SFTP stays routed to the right pod; keepalive.
6. **Notebook running + image ≥ 0.0.90**; surface a clear message otherwise.
7. **Host-key TOFU** UX (first-connect trust).

---

## 9. Non-goals (for this feature)
- No running of notebook cells over SSH (kernels stay in the embedded web UI). This feature is the
  **file browser**. Terminal is an optional extra (phase 3), not the core.
- No bundling of a browser or a vscode-server; Approach R is opt-in.
