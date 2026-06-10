import { describe, expect, it } from "vitest";
import { ConsoleApiClient } from "../../src/console/apiClient";

interface Captured {
  url: string;
  headers: Record<string, string>;
}

function stubFetch(body: unknown, captured: Captured[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(input),
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
    });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("ConsoleApiClient.listWorkspaces", () => {
  it("GETs /user/v1/workspaces/ without x-workspace-id and parses the array", async () => {
    const captured: Captured[] = [];
    const client = new ConsoleApiClient({
      baseUrl: "https://console.cloud.ru/aicloud/ui",
      getToken: async () => "tok",
      fetchImpl: stubFetch(
        [{ workspace_id: "w1", workspace_name: "Alpha", project_name: "P", email: "a@x" }],
        captured,
      ),
    });

    const out = await client.listWorkspaces();

    expect(out).toEqual([
      { workspace_id: "w1", workspace_name: "Alpha", project_name: "P", email: "a@x" },
    ]);
    expect(captured[0]?.url).toBe("https://console.cloud.ru/aicloud/ui/user/v1/workspaces/");
    expect(captured[0]?.headers["Authorization"]).toBe("Bearer tok");
    expect("x-workspace-id" in (captured[0]?.headers ?? {})).toBe(false);
  });

  it("returns [] when the body is not an array", async () => {
    const captured: Captured[] = [];
    const client = new ConsoleApiClient({
      baseUrl: "https://console.cloud.ru/aicloud/ui",
      getToken: async () => "tok",
      fetchImpl: stubFetch({ unexpected: true }, captured),
    });
    expect(await client.listWorkspaces()).toEqual([]);
  });
});

describe("ConsoleApiClient.listNotebooks", () => {
  it("sends x-workspace-id for workspace-scoped calls", async () => {
    const captured: Captured[] = [];
    const client = new ConsoleApiClient({
      baseUrl: "https://console.cloud.ru/aicloud/ui",
      getToken: async () => "tok",
      fetchImpl: stubFetch({ notebooks: [] }, captured),
    });

    await client.listNotebooks({ workspaceId: "w1", workspaceName: "Alpha" });

    expect(captured[0]?.headers["x-workspace-id"]).toBe("w1");
  });
});
