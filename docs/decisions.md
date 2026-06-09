# Decisions & open questions

Locked choices and the questions that need a product/owner answer before or during implementation.
Each decision lists the recommendation, the alternative, and the trade-off.

## D1 — Authentication method (LOCKED for Phase 1: key-only)

**Decision: service-account Access Key**, pasted as a single value and exchanged at
`POST /public/v2/service_auth` for a Bearer token. No browser, no password, no OAuth client.

- ➕ Officially documented, headless, works in remote/SSH/web VS Code.
- ➕ Same key family already used by other Cloud.ru tooling in this monorepo (`ai_reviewer`).
- ➖ Two secrets under the hood (Key ID + Key Secret); we hide this by accepting one paste
  (`KEY_ID:KEY_SECRET` or the console JSON) — see `src/auth/credentialInput.ts`.

### Why not "pure single API key as Bearer" like Foundation Models?
Foundation Models (`foundation-models.api.cloud.ru/v1`) accepts a single API-key secret directly as
`Authorization: Bearer …` — its gateway maps the key to the account. **The ML Space notebooks API does
not work this way**, confirmed by its OpenAPI security schemes:
- `GET /public/v2/notebooks/v2/notebooks` requires **both** schemes together (`{api_key, access_token}`):
  - `access_token` = an **HTTP Bearer JWT obtained from `/service_auth`** (the spec says exactly this —
    a raw key is not accepted as the Bearer), **and**
  - `api_key` = the per-workspace `x-api-key` header, **plus** an `x-workspace-id` header.

So a literal one-key-as-bearer call is impossible here. The closest equivalent — and what Phase 1 does —
is **key-only from the user's side**: paste the Access Key once; the extension transparently performs the
`service_auth` exchange, fetches the `x-api-key` (`GET /workspaces/v1/x_api_key`), and selects the
workspace (`GET /workspaces/v3/`, auto when only one). The user never deals with tokens, passwords, or
a browser.

### Dual exchange (service_auth → IAM fallback)
`service_auth` is specifically *service-account* auth; it returns
`{"error_code":22,"error_message":"error during service account auth"}` (HTTP 401) for a key it does
not accept — notably **personal** access keys. So `MlSpaceApiClient.authenticate()` tries `service_auth`
first and, on a 401, falls back to the IAM `access_key` grant
(`POST https://id.cloud.ru/auth/system/openid/token`, `grant_type=access_key`), which accepts both
personal and service-account access keys. The path used is logged ("via service_auth" / "via iam").

> Recommended key for the smoothest path: a **service account** access key (Пользователи → Сервисные
> аккаунты → API-ключ) with a role granting access to the target ML Space workspace. A personal access
> key (Профиль → Ключи доступа) also works via the IAM fallback. If both exchanges 401, the key is
> wrong/expired or lacks workspace access — not a code issue.

**Alternative (Phase 6): interactive OIDC SSO** via `https://id.cloud.ru` authorization-code + PKCE,
wrapped in a VS Code `AuthenticationProvider`.

- ➕ True "Sign in through Cloud.ru" browser UX, no manual key handling.
- ➖ Requires a **registered public OAuth client** (client_id + redirect URI like
  `vscode://cloudru.cloudru-jupyter-vscode/auth`) provisioned by the Cloud.ru IAM team — an external
  dependency and a security review. Until that exists, this path is blocked.

> The wording "логиниться через cloud.ru" fits both. Build the `AuthService` behind an interface so the
> OIDC provider can drop in without touching the API client or UI. **Action: confirm whether product
> wants interactive SSO for v1; if yes, secure the OAuth client first.**

## D2 — DTO types: generate vs hand-write
**Decision:** generate from `docs/reference/mlspace-public-api.openapi.json` with `openapi-typescript`;
hand-curate only the ~10 view-models in `src/api/types.ts`. 136 paths / 100+ schemas — hand-typing
would rot. Commit `generated.ts` (reproducible) so consumers don't need the generator at build time;
regenerate via `pnpm gen:api` when the spec version bumps (currently `2.7.0`).

## D3 — Open scope: single file vs mounted folder
**MVP:** open the selected remote `.ipynb` via the `cloudru-jupyter://` FileSystemProvider.
**Phase 2 of the feature:** also offer "Open notebook workspace" that adds the notebook root as a
workspace folder so the entire remote tree is browsable. Folder-mount changes the window's workspace,
so make it explicit/opt-in.

## D4 — List endpoint version
**Decision:** use `GET /public/v2/notebooks/v2/notebooks` (returns `url`, rich fields). The v1
`/{namespace}/notebook` list is deprecated and lacks `url`. Keep v1 *only* for the `namespace` value,
which actually comes from the `Workspace` object — so v1 list is not needed at all.

## D5 — Where `namespace` comes from
The v2 notebook item has **no** `namespace`, but resume/pause-v1 need it. Source it from the selected
`Workspace.namespace` (cached in `WorkspaceCtx`). Pause has a v2 variant that needs only `uid` —
prefer it; resume is v1-only and needs `namespace`.

---

## Open questions for the team (answer to de-risk Phase 3/4)
1. **Proxy auth:** what does the auth-proxy in front of a notebook `url` accept — `Authorization:
   Bearer`, a portal session cookie, or a token embedded in `url`/`portal_ref`? (Blocks kernel + FS.)
2. **WebSocket:** does the proxy forward `/api/kernels/.../channels` WS upgrades with those auth
   headers? Any sticky-session/affinity requirement?
3. **`x-api-key`:** account-wide or per-workspace from `/workspaces/v1/x_api_key`?
4. **`url` shape:** does it end at the server root or at `/lab`? Any per-session query token?
5. **OIDC client:** is there (or can there be) a registered public OAuth client for interactive SSO
   (D1)?
6. **Self-hosted/isolated installs:** do we need a configurable API host besides `api.ai.cloud.ru`?
   (`cloudru.api.baseUrl` already exists for this.)
