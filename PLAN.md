# Implementation Plan — Cloud.ru ML Space Notebooks (VS Code extension)

**Audience:** the coding model/engineer implementing this extension.
**Read first:** `docs/api-contract.md` (grounded Cloud.ru API), `docs/decisions.md` (locked choices &
open questions), `docs/reference/mlspace-public-api.openapi.json` (authoritative API),
`docs/reference/vscode-jupyter-api.d.ts` (authoritative VS Code Jupyter API).

---

## 0. Goal & success criteria

Replace today's "open the notebook in a browser by URL" flow with a native VS Code flow:

1. **Sign in to Cloud.ru** from inside VS Code.
2. **Pick a workspace**, then see the **list of Jupyter Server notebooks** that were created in the
   Cloud.ru ML Space console.
3. **Select a notebook and open it in VS Code** — edit the remote `.ipynb` files and run cells against
   the remote kernel — instead of opening JupyterLab in a browser tab.

**Definition of done (end-to-end, on a real workspace):**
- User signs in with Cloud.ru service-account keys; token is stored in `SecretStorage`, auto-refreshed.
- The "Cloud.ru ML Space" view lists real notebooks with live status icons.
- Selecting a **running** notebook opens its remote files in VS Code and a cell executes on the remote
  kernel (output returns).
- Selecting a **paused** notebook offers Resume; after it reaches `running`, the open flow works.
- "Open in Browser" still works as a fallback (parity with today).
- Errors (401/403/429/network/TLS) surface as actionable messages, not silent failures.

---

## 1. Architecture

```
┌────────────────────────────── VS Code extension host ──────────────────────────────┐
│                                                                                      │
│  extension.ts (activate)                                                             │
│    ├── AuthService ───────────────► Cloud.ru auth (service_auth) + SecretStorage     │
│    ├── MlSpaceApiClient ──────────► https://api.ai.cloud.ru/public/v2/*  (REST)      │
│    ├── SessionStore ──────────────► current {token, workspace, x-api-key}            │
│    ├── NotebooksTreeProvider ─────► TreeView "cloudruNotebooks" (status, actions)     │
│    ├── CloudruServerProvider ─────► registers JupyterServerCollection (kernels)       │
│    │        (impl JupyterServerProvider from @vscode/jupyter-extension)              │
│    ├── CloudruFsProvider ─────────► FileSystemProvider over Jupyter Contents API     │
│    │        scheme: cloudru-jupyter://<notebookUid>/<path>                           │
│    └── commands/* ────────────────► signIn/out, selectWorkspace, open, resume, pause │
│                                                                                      │
└──────────────────────────────────────────────────────────────────────────────────┘
        │ Bearer + x-api-key + x-workspace-id                 │ proxy auth (Bearer/cookie — verify)
        ▼                                                      ▼
  Cloud.ru ML Space public API                         Notebook pod: JupyterLab @ url
  (auth, workspaces, notebooks list, resume/pause)     (/api/contents, /api/kernels, /api/sessions, ws)
```

Two VS Code integration surfaces do the heavy lifting:

- **Kernels** — implement `JupyterServerProvider` and register it via
  `jupyterExt.exports.createJupyterServerCollection(id, label, provider)`. `resolveJupyterServer`
  returns `connectionInformation = { baseUrl, token?, headers? }`. This is the supported, future-proof
  API (the old `registerRemoteServerProvider` is deprecated). Auth to the proxy rides in `headers`.
- **Files** — a `FileSystemProvider` backed by the notebook's **Jupyter Contents API**
  (`GET/PUT <url>api/contents/<path>`) so the remote `.ipynb` tree shows up and opens in VS Code.

> Why both: the Jupyter server provider supplies *compute* (kernels); the FS provider supplies the
> *documents*. Opening a notebook = open the remote file (FS provider) + pick the Cloud.ru kernel
> (server provider). This mirrors the in-browser JupyterLab experience.

---

## 2. Authentication design

**MVP credential type: service-account Access Key** (`client_id`/`client_secret`). Rationale and the
interactive-OIDC alternative are in `docs/decisions.md` (Decision D1 — confirm with product).

### 2.1 `AuthService` (`src/auth/authService.ts`)

State machine: `signedOut → authenticating → signedIn(token, expiresAt) → refreshing → signedOut`.

- `signIn()`:
  1. Prompt with a single `showInputBox` (password) that accepts the access key pasted as
     `KEY_ID:KEY_SECRET` or the console JSON; `parseAccessKey` (`src/auth/credentialInput.ts`) splits
     it, falling back to two separate fields when it can't be parsed. (Implemented.)
  2. `POST {baseUrl}/public/v2/service_auth { client_id, client_secret }` → `BaseToken`.
  3. Store the parsed `{clientId, clientSecret}` as one JSON blob in `context.secrets`
     (`cloudru.credentials`). Store nothing in plaintext settings.
  4. Cache `{ accessToken, expiresAt = now + expires_in*1000 }` in memory only.
  5. `setContext('cloudru.authenticated', true)` and fire `onDidChangeAuth`.
- `getAccessToken()`: returns a valid token, transparently re-running the credential exchange when
  `now > expiresAt - 60s` (no refresh-token in this grant; re-auth with stored keys).
- `signOut()`: clear secrets + memory, `setContext('cloudru.authenticated', false)`, fire event,
  dispose the Jupyter collection + tree.

> Token lifetime is `expires_in` (≈3600s). There is no refresh token in the `access_key` grant, so
> "refresh" = repeat 1.1 with the stored keys. Keep credentials in `SecretStorage` only.

### 2.2 Connection-header factory (`src/auth/connectionHeaders.ts`)

Single function `buildJupyterConnectionHeaders(session): Promise<Record<string,string>>` that the
FS provider and the Jupyter server provider both call. It must be the **only** place that decides how
to authenticate to the notebook proxy, because that scheme is the #1 unknown (see §6, verification 1).
Implement it to support all three candidates and select via a setting/probe:
- Bearer: `{ Authorization: 'Bearer ' + token }`
- Cookie: `{ Cookie: '<portal session cookie>' }`
- token-in-url: no header (token already in `url`).

---

## 3. API client (`src/api/`)

`src/api/mlspaceClient.ts` — thin typed wrapper over `fetch` (Node 18+ global fetch; respect
`cloudru.api.verifyTls` via an `undici` Agent when false). One method per endpoint we use:

```ts
class MlSpaceApiClient {
  constructor(opts: { baseUrl: string; getToken: () => Promise<string>; verifyTls: boolean }) {}
  authServiceAccount(creds: ServiceAccount): Promise<BaseToken>;          // POST /public/v2/service_auth
  getXApiKey(): Promise<string>;                                          // GET  /public/v2/workspaces/v1/x_api_key
  listWorkspaces(): Promise<Workspace[]>;                                 // GET  /public/v2/workspaces/v3/
  listNotebooks(ws: WorkspaceCtx, q?: ListNotebooksQuery): Promise<NotebookHandlerResponse[]>;
                                                                          // GET  /public/v2/notebooks/v2/notebooks
  getNotebook(ws: WorkspaceCtx, uid: string): Promise<AsyncCreateNotebookResponse>;
                                                                          // GET  /public/v2/notebooks/v1/notebook/{uuid}
  resumeNotebook(ws, uid, body: ResumeNotebookPayload): Promise<void>;    // POST .../v1/{namespace}/notebook/{uuid}/resume
  pauseNotebook(ws, uid): Promise<void>;                                  // POST .../v2/notebook/{uuid}/pause
}
```

- `WorkspaceCtx = { workspaceId, xApiKey, namespace }`. Every data call injects the three headers
  (`Authorization`, `x-api-key`, `x-workspace-id`) from it; `namespace` is needed only for resume.
- Centralize error mapping: 401→`AuthError` (trigger re-auth), 403→`ForbiddenError`, 404→`NotFound`,
  429→`RateLimitError` (with retry-after backoff), 5xx→`BackendError`. Surface messages from the
  typed error bodies in the spec.
- **Generate DTO types from the OpenAPI file** (don't hand-type 130 schemas). Add a dev script:
  `pnpm dlx openapi-typescript docs/reference/mlspace-public-api.openapi.json -o src/api/generated.ts`.
  Re-export the handful we use from `src/api/types.ts`. (Pin `openapi-typescript` in devDeps.)

`src/api/types.ts` — re-exports + small view-models the UI needs (e.g. `NotebookListItem` derived from
`NotebookHandlerResponse` with a normalized `isRunning`, `isPaused`, `canOpen`).

---

## 4. Session & workspace selection (`src/session/`)

- `SessionStore` holds the active `WorkspaceCtx` and exposes `onDidChangeWorkspace`.
- `selectWorkspace` command: `listWorkspaces()` → `window.showQuickPick` (label `name`, detail
  `project_name · owner_email`) → resolve `xApiKey` (§1.2; if account-wide, fetch once and reuse) →
  persist last workspace id in `workspaceState` and restore on activation.
- If exactly one workspace exists, auto-select it.

---

## 5. UI — Notebooks tree (`src/views/notebooksTree.ts`)

`TreeDataProvider<NotebookNode>` bound to view `cloudruNotebooks`:

- Root children = notebooks from `listNotebooks` for the active workspace (sorted by
  `creationTimestamp desc`).
- Each `TreeItem`:
  - `label` = `name`; `description` = `imageDisplayName · instanceType`.
  - `iconPath` from status: `running`→`$(vm-running)` green, `paused*`→`$(vm-outline)`,
    `creating/resuming/waiting`→`$(loading~spin)`, `error`→`$(error)`.
  - `contextValue` = `notebook.running` | `notebook.paused` | `notebook.busy` (drives inline menus in
    `package.json` — already wired).
  - `tooltip` = MarkdownString with author, region, status, created date, url.
  - default `command` = `cloudru.openNotebook` for running notebooks.
- `refresh()` re-queries; auto-refresh paused/busy rows on a short interval **only while the view is
  visible** (`TreeView.onDidChangeVisibility`) and debounce to respect rate limits.
- Empty/auth states handled by `viewsWelcome` in `package.json` (sign-in button).

---

## 6. Opening a notebook in VS Code (`src/jupyter/`)

This is the core. Two providers + an orchestrating command.

### 6.1 Acquire the live notebook (command `cloudru.openNotebook`)
1. If `status` is `paused*` → ask to resume (§7); else if not `running` → show "notebook is
   {status}, try later".
2. `getNotebook(uid)` to get a fresh `url` (the list item `url` can be stale/null).
3. Normalize `baseUrl` = `url` ensuring a single trailing slash; strip a trailing `lab`/`tree` path
   if present so it points at the server root that serves `/api/*`.

### 6.2 `CloudruServerProvider` (`src/jupyter/serverProvider.ts`) — kernels
- On activation, get the Jupyter extension and register the collection:
  ```ts
  const jupyter = await extensions.getExtension<Jupyter>('ms-toolsai.jupyter')!.activate();
  collection = jupyter.createJupyterServerCollection('cloudru-mlspace', 'Cloud.ru ML Space', provider);
  collection.commandProvider = /* optional: "Sign in to Cloud.ru…" */;
  ```
- `provideJupyterServers()` → map the **running** notebooks of the active workspace to
  `JupyterServer { id: uid, label: name }`.
- `resolveJupyterServer(server)` → `{ ...server, connectionInformation: { baseUrl: Uri.parse(baseUrl),
  headers: await buildJupyterConnectionHeaders(session) } }`. Use `token` instead of/with `headers`
  per the verified scheme (§ verification 1). Fire `onDidChangeServers` when the notebook list/auth
  changes.

### 6.3 `CloudruFsProvider` (`src/jupyter/fsProvider.ts`) — remote files
- Register `workspace.registerFileSystemProvider('cloudru-jupyter', provider, { isCaseSensitive:true })`.
- URI shape: `cloudru-jupyter://<notebookUid>/<path-inside-jupyter-root>`.
- Implement against the **Jupyter Contents API** of that notebook's `baseUrl` (auth via the same header
  factory):
  - `readDirectory` → `GET {baseUrl}api/contents/{path}` (type=directory) → map `content[]`.
  - `readFile` → `GET {baseUrl}api/contents/{path}?content=1` → decode `content` (base64 for
    `format==='base64'`, else utf-8 JSON/text).
  - `writeFile` → `PUT {baseUrl}api/contents/{path}` with `{type, format, content}`.
  - `stat`, `createDirectory`, `delete`, `rename` → corresponding Contents API verbs.
  - Send `X-XSRFToken` only if required (server has `disable_check_xsrf=True`, so likely not).
- Opening: resolve `<root>` listing, then `commands.executeCommand('vscode.openWith', uri,
  'jupyter-notebook')` for `.ipynb`, or `vscode.open` for other files. Add the notebook root as a
  workspace folder (`workspace.updateWorkspaceFolders`) named after the notebook so the user browses
  the whole tree, OR open just the chosen file — **MVP: open the file the user picked; Phase 2: mount
  the folder.** (See decision D3.)

### 6.4 Kernel selection glue
After opening the `.ipynb`, the user picks the kernel. The Cloud.ru collection appears in the kernel
picker; selecting it connects via the resolved `connectionInformation`. For a smoother UX you may
pre-trigger `commands.executeCommand('notebook.selectKernel', { ... })` (best-effort; the Jupyter
extension owns the final binding).

---

## 7. Resume / pause (`src/commands/lifecycle.ts`)
- `cloudru.resumeNotebook`: build `ResumeNotebookPayload` from the item (`region` ← item.region,
  `instance_type` ← item.instanceType) falling back to settings/workspace allocation; call resume;
  then `withProgress` poll `getNotebook(uid)` every ~3s until `running` or terminal error/timeout
  (~5 min). On success, continue the open flow if invoked from "open".
- `cloudru.pauseNotebook`: confirm → v2 pause → refresh tree.

---

## 8. Commands & wiring (`src/extension.ts`, `src/commands/index.ts`)
Register all commands from `package.json`:
`signIn, signOut, selectWorkspace, refreshNotebooks, openNotebook, openNotebookInBrowser,
resumeNotebook, pauseNotebook`. `openNotebookInBrowser` = `env.openExternal(Uri.parse(url))`
(today's behavior, kept as fallback). Dispose providers/collection on `signOut`/deactivate.

---

## 9. Project structure
```
src/
  extension.ts                 // activate/deactivate, DI wiring
  auth/
    authService.ts
    connectionHeaders.ts
  api/
    mlspaceClient.ts
    generated.ts               // openapi-typescript output (gitignored or committed — see D2)
    types.ts                   // curated re-exports + view-models
    errors.ts
  session/
    sessionStore.ts
  views/
    notebooksTree.ts
  jupyter/
    serverProvider.ts
    fsProvider.ts
    contentsApi.ts             // small Contents API client used by fsProvider
  commands/
    index.ts
    lifecycle.ts
  util/
    logger.ts                  // OutputChannel "Cloud.ru ML Space"
    polling.ts
media/                          // icon.png, activity-icon.svg
test/
  unit/                         // vitest: client header building, error mapping, status mapping
  integration/                  // @vscode/test-electron: activation, tree, command registration
docs/                           // this folder
```

---

## 10. Phased delivery (each phase ends green & demoable)

### Phase 1 — Auth + API client (no UI yet)
- `AuthService` (service_auth + SecretStorage), `MlSpaceApiClient` with `authServiceAccount`,
  `getXApiKey`, `listWorkspaces`, `listNotebooks`. Generated DTO types wired.
- **Acceptance:** a unit/integration test (or a scratch command) signs in with env-provided keys and
  logs N notebooks for a workspace. Error mapping covered by unit tests (401/429/network).

### Phase 2 — Tree UI + workspace picker + browser fallback
- Activity-bar view, `NotebooksTreeProvider`, `selectWorkspace`, `refreshNotebooks`,
  `openNotebookInBrowser`, status icons, welcome/sign-in states.
- **Acceptance:** real notebooks render with correct status; "Open in Browser" reaches today's URL;
  sign-out clears the view.

### Phase 3 — Connect kernel (JupyterServerProvider) ★ core
- `CloudruServerProvider` registered; running notebooks selectable in the kernel picker.
- **Resolve verification 1 here** (proxy auth scheme) and lock `connectionHeaders`.
- **Acceptance:** open a *local* scratch `.ipynb`, pick a Cloud.ru notebook as the server/kernel, run
  `print(2+2)` → output `4` from the remote kernel.

### Phase 4 — Remote files (FileSystemProvider) + one-click open ★ core
- `CloudruFsProvider` + `contentsApi`; `cloudru.openNotebook` opens the chosen remote `.ipynb`.
- **Acceptance:** clicking a running notebook in the tree opens its remote `.ipynb` in VS Code, edits
  save back (Contents API `PUT`), and cells run on the remote kernel.

### Phase 5 — Lifecycle + polish
- `resumeNotebook`/`pauseNotebook` with progress polling; rate-limit backoff; auto-refresh while
  visible; OutputChannel logging; settings.
- **Acceptance:** resuming a paused notebook then opening it works end-to-end; 429s back off.

> Later/Phase 6 (out of MVP): mount the notebook root as a workspace folder; interactive OIDC SSO
> (D1); create-notebook from VS Code; tensorboard; multi-workspace tree grouping.

---

## 11. Risks & verification (do not skip)
1. **Proxy auth to the Jupyter server (highest risk).** The server has no token; the portal proxy
   guards `url`. Empirically determine what `GET {url}api/kernelspecs` accepts (Bearer header vs
   session cookie vs token-in-url) before building Phase 3. Everything downstream depends on this.
2. **CORS/WebSocket from the extension host.** REST is server-side `fetch` (no CORS), but the Jupyter
   extension opens a **WebSocket** to `/api/kernels/.../channels`. Confirm the proxy forwards WS and
   accepts the auth headers on the WS upgrade. `disable_check_xsrf=True` helps; verify upgrade headers.
3. **`x-api-key` scope.** Confirm whether `GET /workspaces/v1/x_api_key` is account-wide or
   per-workspace (§1.2). Adjust fetch timing accordingly.
4. **`baseUrl` normalization.** `url` may point at `/lab`; the server provider/Contents API need the
   server root. Verify the exact suffix on a live `url`.
5. **Token expiry mid-session.** Long kernel sessions outlive the 1h token. The header factory must
   fetch a fresh token per request/upgrade; verify the proxy tolerates rotating Bearer tokens (cookie
   scheme would sidestep this).
6. **Rate limits** (100 GET/min). Debounce/auto-refresh carefully.
7. **TLS** in isolated installs — honor `cloudru.api.verifyTls` for both API and Jupyter calls.

---

## 12. Testing strategy
- **Unit (vitest):** header construction (all three auth modes), error mapping per status, status→icon
  mapping, `baseUrl` normalization, paused→resume payload derivation. Mock `fetch`. No network.
- **Integration (`@vscode/test-electron`):** activation, command registration, tree renders from a
  faked client, sign-out clears context. Gate live-API tests behind env creds
  (`CLOUDRU_CLIENT_ID/SECRET/WORKSPACE_ID`) and skip when absent — never commit creds.
- **Manual smoke (record results):** the Phase 3/4 acceptance flows on a real workspace.
- Do **not** mock the Jupyter extension API in a way that hides verification 1/2 — those must be
  exercised against a real notebook at least once.

---

## 13. Security
- Credentials only in `context.secrets`. Never log tokens/secrets/cookies (scrub in `logger`).
- `verifyTls` defaults true; warn loudly when disabled.
- Treat remote notebook content as untrusted; rely on VS Code's notebook trust model.
