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
