# Cloud.ru ML Space — API contract (grounded reference)

> Source of truth: `docs/reference/mlspace-public-api.openapi.json` (MLSpace public API **v2.7.0**,
> fetched from `https://api.ai.cloud.ru/public/v2/openapi.json`).
> Everything below is extracted verbatim from that spec + the Cloud.ru docs. Do **not** invent fields;
> if you need a shape that is not here, read the OpenAPI file.

All ML Space endpoints are served under base `https://api.ai.cloud.ru` with the prefix `/public/v2`.
Interactive docs: `https://api.ai.cloud.ru/public/v2/redoc` and `.../docs`.

> ⚠️ DNS note from the docs: a secondary IP `176.109.98.3` should be whitelisted in firewalls to
> survive A-record updates of `api.ai.cloud.ru`.

---

## 1. Authentication

There are **two** credential exchanges in this product. We use them in sequence.

> Not Foundation-Models-style: FM (`foundation-models.api.cloud.ru/v1`) takes a single API key as
> `Authorization: Bearer`. The notebooks API does **not** — its security requires a `service_auth`-issued
> **JWT** Bearer **and** the per-workspace `x-api-key` **and** `x-workspace-id` (§1.3). So the flow below
> is mandatory; we just hide it behind one pasted key. See `docs/decisions.md` D1.

### 1.1 Service-account credentials → access token (chosen for MVP)

A user creates a **service account + Access Key** in the Cloud.ru console
(`client_id` = Key ID / login, `client_secret` = Key Secret / password).
See <https://cloud.ru/docs/console_api/ug/topics/guides__api_key.html>.

**Option A — ML Space `service_auth` (recommended, single host):**

```
POST https://api.ai.cloud.ru/public/v2/service_auth
Content-Type: application/json

{ "client_id": "<KEY_ID>", "client_secret": "<KEY_SECRET>" }   // schema: ServiceAccount
```

Response `200` → `ServiceAuthResponse`:

```jsonc
{
  "token": {                       // schema: BaseToken
    "access_token": "eyJhbGci...", // <- Bearer token for all subsequent calls
    "token_type": "Bearer",
    "expires_in": 3600             // seconds; refresh before expiry
  }
}
```

`401` → `ServiceAuthInvalidCredentialsErrorResponse`, `429` → `TooManyRequestsErrorResponse`.

**Option B — Cloud.ru IAM (OpenID, equivalent, different host):**

```
POST https://id.cloud.ru/auth/system/openid/token
Content-Type: application/x-www-form-urlencoded

grant_type=access_key&client_id=<KEY_ID>&client_secret=<KEY_SECRET>
```

Returns the standard OIDC `{ access_token, expires_in, token_type }`. Use Option A unless the team
requires the IAM host; behaviour for the ML Space API is identical (Bearer token).

### 1.2 Workspace `x-api-key`

```
GET https://api.ai.cloud.ru/public/v2/workspaces/v1/x_api_key
Authorization: Bearer <access_token>
x-workspace-id: <workspace uuid>          # REQUIRED in practice (see note)
```

Response `200` → `APIKeyResponse`:
```jsonc
{ "x-api-key": "eeeeccee-eeee-eeee-eeee-eeaeefeeb49c" }
```

> CONFIRMED on a live workspace: although the OpenAPI declares **no** `x-workspace-id` parameter, the
> key is **per-workspace** and the endpoint only returns the correct key when you send the
> `x-workspace-id` header. Call it **after** the workspace is selected. (Verified: 200 + key with the
> header.) The extension does this automatically; manual paste remains a fallback.

### 1.3 Headers required by data endpoints

Every ML Space data call (configs, notebooks, etc.) requires **all three**:

```
Authorization: Bearer <access_token>
x-api-key: <workspace x-api-key>
x-workspace-id: <workspace uuid>
```

---

## 2. Workspaces

### 2.1 List workspaces (for the workspace picker)

```
GET /public/v2/workspaces/v3/
Authorization: Bearer <token>
```

Response `200` → `ListWorkspacesResponse`:

```jsonc
{
  "workspaces": [ /* Workspace[] */ ]
}
```

`Workspace` (all fields required):

```jsonc
{
  "id":          "uuid",          // <- this is the x-workspace-id
  "name":        "string",
  "namespace":   "string",        // <- REQUIRED for notebook resume/pause (v1 endpoints)
  "project_id":  "uuid",
  "project_name":"string",
  "owner_email": "string",
  "allocations": [                 // WorkspaceAllocation[]
    { "id": "string", "name": "string", "cluster_key": "string", "cluster_name": "string|null" }
  ]
}
```

> `namespace` lives **only** on the workspace, not on the notebook list item — cache it per workspace.
> `allocations[].cluster_key` maps to the ML Space region group (used for resume `region`).

---

## 3. Notebooks (Jupyter Servers)

### 3.1 List notebooks — primary endpoint (v2)

```
GET /public/v2/notebooks/v2/notebooks
Authorization: Bearer <token>
x-api-key: <x-api-key>
x-workspace-id: <workspace uuid>
```

Query params (all optional): `notebook_type` (`Spark`|`Default`), `order_by` (`name`|`creationTimestamp`,
default `creationTimestamp`), `desc` (bool), `limit` (int≥1), `offset` (int≥0), `search` (string),
`status` (comma list, e.g. `creating,running`), `access_mode` (comma list: `private,shared,multiuser`).

Response `200` → `ListNotebooksResponseV2`:

```jsonc
{ "notebooks": [ /* NotebookHandlerResponse[] */ ] }
```

**`NotebookHandlerResponse` — the model the UI binds to:**

| field                     | type                | notes |
|---------------------------|---------------------|-------|
| `uid`                     | string (required)   | notebook id; used in pause/modify/get-by-uuid |
| `name`                    | string (required)   | display name |
| `status`                  | `NotebookStatus`    | see enum below |
| `url`                     | string \| null      | **the Jupyter URL opened today in the browser** |
| `image`                   | string (required)   | full image ref |
| `imageDisplayName`        | string (required)   | human image name |
| `instanceType`            | string \| null      | e.g. `free.0gpu` |
| `region`                  | string (required)   | e.g. `DGX2-MT` |
| `author`                  | string (required)   | owner email |
| `description`             | string \| null      | |
| `is_shared`               | bool (required)     | |
| `portal_ref`              | string (required)   | portal deep-link reference |
| `notebookType`            | string \| null      | |
| `pause_at`                | string \| null      | scheduled pause time |
| `postponed_pause_enabled` | bool \| null        | |
| `allocation_name`         | string \| null      | |
| `queue_name`              | string \| null      | |
| `creationTimestamp`       | number \| null      | epoch |
| `updated_at`              | date-time \| null   | |
| `s3_buckets`              | `S3BucketDB[]`      | mounted buckets |
| `s3_credentials`          | object \| null      | |
| `access_granted`          | bool (default true) | |

> ⚠️ `namespace` is **not** in this item — get it from the selected `Workspace.namespace`.

**`NotebookStatus` enum:**

```
creating | paused | paused_by_schedule | paused_by_metrics | paused_by_timer | pausing |
error | resuming | deleting | waiting | running | warning | fixing
```

Only `running` notebooks expose a live, connectable `url`. Anything in a `paused*` state must be
resumed first (§3.3).

### 3.2 Get one notebook by uuid

```
GET /public/v2/notebooks/v1/notebook/{notebook_uuid}
```

Response `200` → `AsyncCreateNotebookResponse` (superset of the list item: `uid`, `name`, `status`,
`url`, `image`, `short_image`, `instanceType`, `region`, `s3_buckets`, `s3_credentials`, `pause_at`,
`is_shared`, `notebookType`, `updated_at`). `404` → `NotFoundNotebookError`. Poll this after resume
to learn when `status === "running"` and `url` is populated.

### 3.3 Resume a paused notebook

```
POST /public/v2/notebooks/v1/{namespace}/notebook/{notebook_uuid}/resume
x-workspace-id: <workspace uuid>
Content-Type: application/json

{ "region": "DGX2-MT", "instance_type": "free.0gpu" }   // ResumeNotebookPayload (both have defaults)
```

`namespace` ← `Workspace.namespace`. `region`/`instance_type` ← prefer the values from the notebook
item (`region`, `instanceType`); fall back to extension settings. After calling, poll §3.2 until
`running`.

### 3.4 Pause a notebook

```
POST /public/v2/notebooks/v2/notebook/{notebook_uuid}/pause      # v2, body: none, header x-workspace-id
# (v1 equivalent: POST /public/v2/notebooks/v1/{namespace}/notebook/{notebook_uuid}/pause, body PauseNotebookPayload)
```

### 3.5 Deprecated v1 list (do not use unless v2 is unavailable)

`GET /public/v2/notebooks/v1/{namespace}/notebook` → `ListNotebooksResponse { notebooks: NotebookDetail[] }`
(`NotebookDetail` = `uid,name,status,image,age,ageSeconds,author,cpu?,memory?,namespace,reason`).
This one *does* carry `namespace` but lacks `url`; the v2 endpoint is the correct source.

---

## 4. Configs (instance types / images, optional)

```
GET /public/v2/configs?cluster_type=MT     # MT = training + Jupyter Server; INF = deployments
```
Headers: `x-api-key`, `x-workspace-id`, `Authorization`. Response → `ConfigBaseResponse`. Use only if
the extension later needs to offer instance-type choices for resume/create.

---

## 5. Rate limits

GET: 100/min, 10000/day. POST: 30/min, 1000/day. Exceeding → `429`. Cache aggressively, debounce
the tree refresh, and back off on `429`.

---

## 6. Connecting VS Code to the notebook's Jupyter Server (the critical part)

The notebook image (see `mlspace.notebook.architecture=v2`) launches JupyterLab as:

```
jupyter lab --ip=0.0.0.0 --port=8888 --no-browser \
  --NotebookApp.token='' --NotebookApp.password='' \
  --NotebookApp.base_url=${NB_PREFIX} \
  --ServerApp.disable_check_xsrf=True --ServerApp.allow_external_kernels=True
```

Consequences for the client:

1. **There is no Jupyter token/password on the server itself.** Auth is enforced by the Cloud.ru
   **portal/auth-proxy** sitting in front of `url`. So VS Code must satisfy *the proxy*, not Jupyter.
2. `disable_check_xsrf=True` means cross-origin REST/WS calls to `/api/*` are not blocked by XSRF.
3. The server lives under a **base path** (`NB_PREFIX`) — `url` already encodes it; use `url`
   unmodified as the Jupyter `baseUrl`.

**Open verification item #1 (must be confirmed against a live running notebook):** what does the
auth-proxy in front of `url` accept?
   - (a) `Authorization: Bearer <access_token>` header, and/or
   - (b) a portal **session cookie**, and/or
   - (c) a one-time token embedded in `url` / `portal_ref`.

The VS Code Jupyter API lets us pass either a `token` or arbitrary `headers` (see
`docs/reference/vscode-jupyter-api.d.ts`, `JupyterServerConnectionInformation`). Design the auth layer
so the connection headers are produced by a single function that can emit Bearer headers **and/or**
cookies, and confirm the working combination empirically (curl `GET <url>api/kernelspecs` with each
auth style; the one returning `200` JSON is correct).
