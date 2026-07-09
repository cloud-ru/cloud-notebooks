import { describe, expect, it } from "vitest";
import { ConsoleApiClient } from "../../src/console/apiClient";
import type { HttpFetch } from "../../src/console/consoleHttp";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function routedFetch(body: unknown, captured: Captured[]): HttpFetch {
  return async (url, init) => {
    captured.push({ url, method: init.method, headers: { ...init.headers } });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    };
  };
}

/** Fetch that 401s until the request carries `Bearer fresh`, then 200s — models an expired token. */
function expiringFetch(body: unknown, captured: Captured[]): HttpFetch {
  return async (url, init) => {
    captured.push({ url, method: init.method, headers: { ...init.headers } });
    const authorized = init.headers["Authorization"] === "Bearer fresh";
    return {
      ok: authorized,
      status: authorized ? 200 : 401,
      headers: { get: () => null },
      text: async () => (authorized ? JSON.stringify(body) : "unauthorized"),
    };
  };
}

function makeClient(body: unknown, captured: Captured[]): ConsoleApiClient {
  return new ConsoleApiClient({
    baseUrl: "https://console.cloud.ru/aicloud/ui",
    getToken: async () => "tok",
    fetchImpl: routedFetch(body, captured),
  });
}

describe("ConsoleApiClient.listWorkspaces", () => {
  it("GETs /user/v1/workspaces/ without x-workspace-id and returns the flat list", async () => {
    const captured: Captured[] = [];
    const client = makeClient(
      [{ workspace_id: "w1", workspace_name: "mls-team", namespace: "ns-1", project_name: "Dev" }],
      captured,
    );

    const out = await client.listWorkspaces();

    expect(out).toEqual([
      { workspace_id: "w1", workspace_name: "mls-team", namespace: "ns-1", project_name: "Dev" },
    ]);
    expect(captured[0]?.url).toBe("https://console.cloud.ru/aicloud/ui/user/v1/workspaces/");
    expect(captured[0]?.headers["Authorization"]).toBe("Bearer tok");
    expect("x-workspace-id" in (captured[0]?.headers ?? {})).toBe(false);
  });

  it("returns [] when the body is not an array", async () => {
    const captured: Captured[] = [];
    const client = makeClient({ unexpected: true }, captured);
    expect(await client.listWorkspaces()).toEqual([]);
  });
});

describe("ConsoleApiClient.listNotebooks", () => {
  it("sends x-workspace-id for workspace-scoped calls", async () => {
    const captured: Captured[] = [];
    const client = makeClient({ notebooks: [] }, captured);

    await client.listNotebooks({ workspaceId: "w1", workspaceName: "WS" });

    expect(captured[0]?.headers["x-workspace-id"]).toBe("w1");
    expect(captured[0]?.url).toBe(
      "https://console.cloud.ru/aicloud/ui/notebooks/v2/?include_private=true",
    );
  });
});

describe("ConsoleApiClient.resumeNotebook", () => {
  it("POSTs to the namespace-keyed resume endpoint with the body", async () => {
    const captured: Captured[] = [];
    const client = makeClient({}, captured);

    await client.resumeNotebook({ workspaceId: "w1", workspaceName: "WS" }, "ns-7", { name: "nb" });

    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.url).toBe(
      "https://console.cloud.ru/aicloud/ui/jup_web_app/v3/notebooks/ns-7/resume_request",
    );
    expect(captured[0]?.headers["x-workspace-id"]).toBe("w1");
  });
});

describe("ConsoleApiClient.getSshGatewayConfig", () => {
  const body = {
    regions: [
      { key: "A100-MT", ssh: { port: "2222", url: "ssh-a100-jupyter.ai.cloud.ru" } },
      { key: "SR008", ssh: { port: "2222", url: "ssh-sr008-jupyter.ai.cloud.ru" } },
    ],
    quantumImages: [{ key: "CCE-MT", ssh: null }],
  };

  it("matches the notebook region key and parses its ssh host/port", async () => {
    const captured: Captured[] = [];
    const client = makeClient(body, captured);

    const cfg = await client.getSshGatewayConfig({ workspaceId: "w1", workspaceName: "WS" }, "MT", "SR008");

    expect(cfg).toEqual({ url: "ssh-sr008-jupyter.ai.cloud.ru", port: 2222 });
    expect(captured[0]?.url).toBe(
      "https://console.cloud.ru/aicloud/ui/jup_web_app/v3/notebooks/config?region_type=MT",
    );
    expect(captured[0]?.headers["x-workspace-id"]).toBe("w1");
  });

  it("matches case-insensitively", async () => {
    const client = makeClient(body, []);
    expect(
      (await client.getSshGatewayConfig({ workspaceId: "w1", workspaceName: "WS" }, "MT", "sr008"))?.url,
    ).toBe("ssh-sr008-jupyter.ai.cloud.ru");
  });

  it("returns undefined when the region is absent or has no ssh host", async () => {
    const client = makeClient(body, []);
    expect(
      await client.getSshGatewayConfig({ workspaceId: "w1", workspaceName: "WS" }, "MT", "SR999"),
    ).toBeUndefined();
    expect(
      await client.getSshGatewayConfig({ workspaceId: "w1", workspaceName: "WS" }, "MT", "CCE-MT"),
    ).toBeUndefined();
  });
});

describe("ConsoleApiClient auth retry", () => {
  it("re-mints the token and retries once after a 401", async () => {
    const captured: Captured[] = [];
    const tokens = ["stale", "fresh"];
    const client = new ConsoleApiClient({
      baseUrl: "https://console.cloud.ru/aicloud/ui",
      getToken: async (forceRefresh?: boolean) => (forceRefresh ? "fresh" : tokens.shift() ?? "fresh"),
      fetchImpl: expiringFetch({ notebooks: [] }, captured),
    });

    const out = await client.listNotebooks({ workspaceId: "w1", workspaceName: "WS" });

    expect(out).toEqual([]);
    expect(captured).toHaveLength(2);
    expect(captured[0]?.headers["Authorization"]).toBe("Bearer stale");
    expect(captured[1]?.headers["Authorization"]).toBe("Bearer fresh");
  });

  it("surfaces an auth error when the retry also 401s", async () => {
    const captured: Captured[] = [];
    const client = new ConsoleApiClient({
      baseUrl: "https://console.cloud.ru/aicloud/ui",
      getToken: async () => "still-stale",
      fetchImpl: expiringFetch({ notebooks: [] }, captured),
    });

    await expect(client.listNotebooks({ workspaceId: "w1", workspaceName: "WS" })).rejects.toMatchObject({
      kind: "auth",
    });
    expect(captured).toHaveLength(2);
  });
});
