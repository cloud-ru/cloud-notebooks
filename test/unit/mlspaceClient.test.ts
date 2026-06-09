import { describe, expect, it, vi } from "vitest";
import { MlSpaceApiClient } from "../../src/api/mlspaceClient";
import { ApiError } from "../../src/api/errors";
import type { WorkspaceContext } from "../../src/api/types";

interface Captured {
  url: string;
  init: RequestInit;
}

function clientWith(
  handler: (url: string, init: RequestInit) => Response,
  captured: Captured[] = [],
): MlSpaceApiClient {
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    captured.push({ url: u, init: init ?? {} });
    return handler(u, init ?? {});
  }) as unknown as typeof fetch;

  return new MlSpaceApiClient({
    baseUrl: "https://api.ai.cloud.ru/",
    getToken: async () => "tok-123",
    fetchImpl,
  });
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const ws: WorkspaceContext = {
  workspaceId: "ws-1",
  xApiKey: "key-1",
  namespace: "ns-1",
  workspaceName: "demo",
};

describe("MlSpaceApiClient", () => {
  it("exchanges service-account credentials without an auth header", async () => {
    const captured: Captured[] = [];
    const client = clientWith(
      () => json({ token: { access_token: "abc", token_type: "Bearer", expires_in: 3600 } }),
      captured,
    );

    const token = await client.authServiceAccount({ client_id: "cid", client_secret: "sec" });

    expect(token.access_token).toBe("abc");
    expect(captured[0].url).toBe("https://api.ai.cloud.ru/public/v2/service_auth");
    expect(captured[0].init.method).toBe("POST");
    expect((captured[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(String(captured[0].init.body))).toEqual({ client_id: "cid", client_secret: "sec" });
  });

  it("sends all three workspace headers and default query params when listing notebooks", async () => {
    const captured: Captured[] = [];
    const client = clientWith(
      () => json({ notebooks: [{ uid: "n1", name: "nb", status: "running" }] }),
      captured,
    );

    const notebooks = await client.listNotebooks(ws);

    expect(notebooks).toHaveLength(1);
    const { url, init } = captured[0];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-123");
    expect(headers["x-api-key"]).toBe("key-1");
    expect(headers["x-workspace-id"]).toBe("ws-1");
    expect(url).toContain("/public/v2/notebooks/v2/notebooks");
    expect(url).toContain("order_by=creationTimestamp");
    expect(url).toContain("desc=true");
  });

  it("fetches the per-workspace x-api-key with the x-workspace-id header", async () => {
    const captured: Captured[] = [];
    const client = clientWith(() => json({ "x-api-key": "the-key" }), captured);
    expect(await client.getXApiKey("ws-42")).toBe("the-key");
    const headers = captured[0].init.headers as Record<string, string>;
    expect(headers["x-workspace-id"]).toBe("ws-42");
    expect(headers.Authorization).toBe("Bearer tok-123");
  });

  it("maps a 401 response to an auth ApiError", async () => {
    const client = clientWith(() => json({ detail: "bad token" }, 401));
    await expect(client.listWorkspaces()).rejects.toMatchObject({ kind: "auth", status: 401 });
  });

  it("maps a 429 response and parses Retry-After", async () => {
    const client = clientWith(() => json({}, 429, { "retry-after": "12" }));
    const err = await client.listWorkspaces().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.kind).toBe("rateLimit");
    expect(err.retryAfterSeconds).toBe(12);
  });

  it("wraps transport failures as a network ApiError", async () => {
    const client = clientWith(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(client.getXApiKey()).rejects.toMatchObject({ kind: "network" });
  });
});

describe("MlSpaceApiClient.authenticate", () => {
  it("uses service_auth when it succeeds", async () => {
    const client = clientWith((url) =>
      url.includes("/service_auth")
        ? json({ token: { access_token: "sa", token_type: "Bearer", expires_in: 3600 } })
        : json({}, 500),
    );
    const res = await client.authenticate({ client_id: "id", client_secret: "s" });
    expect(res.via).toBe("service_auth");
    expect(res.token.access_token).toBe("sa");
  });

  it("falls back to IAM on service_auth 401", async () => {
    const captured: Captured[] = [];
    const client = clientWith(
      (url) =>
        url.includes("/service_auth")
          ? json({ error_message: "error during service account auth" }, 401)
          : json({ access_token: "iam-tok", token_type: "Bearer", expires_in: 1800 }),
      captured,
    );
    const res = await client.authenticate({ client_id: "id", client_secret: "s" });
    expect(res.via).toBe("iam");
    expect(res.token.access_token).toBe("iam-tok");
    expect(res.token.expires_in).toBe(1800);
    const iamCall = captured.find((c) => c.url.includes("id.cloud.ru"));
    expect(iamCall).toBeDefined();
    expect(String(iamCall?.init.body)).toContain("grant_type=access_key");
  });
});
