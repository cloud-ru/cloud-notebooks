import { describe, expect, it } from "vitest";
import { ConsoleApiClient } from "../../src/console/apiClient";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Route by URL substring → body; record every request for assertions. */
function routedFetch(routes: Array<[string, unknown]>, captured: Captured[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    captured.push({
      url,
      method: init?.method ?? "GET",
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    const match = routes.find(([needle]) => url.includes(needle));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(match ? match[1] : {}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function makeClient(routes: Array<[string, unknown]>, captured: Captured[]): ConsoleApiClient {
  return new ConsoleApiClient({
    baseUrl: "https://console.cloud.ru/aicloud/ui",
    getToken: async () => "tok",
    fetchImpl: routedFetch(routes, captured),
  });
}

describe("ConsoleApiClient.listCustomers", () => {
  it("GETs /u-api/bff-console/v2/customers/me without x-workspace-id and maps id+name", async () => {
    const captured: Captured[] = [];
    const client = makeClient(
      [["customers/me", { customers: [{ id: "c1", name: "Acme", full_name: "Acme LLC" }] }]],
      captured,
    );

    const out = await client.listCustomers();

    expect(out).toEqual([{ id: "c1", name: "Acme" }]);
    expect(captured[0]?.url).toBe("https://console.cloud.ru/u-api/bff-console/v2/customers/me");
    expect(captured[0]?.headers["Authorization"]).toBe("Bearer tok");
    expect("x-workspace-id" in (captured[0]?.headers ?? {})).toBe(false);
  });
});

describe("ConsoleApiClient.listProjects", () => {
  it("flattens folders → projects and passes customerId", async () => {
    const captured: Captured[] = [];
    const client = makeClient(
      [
        [
          "simple-projects",
          {
            folders: [
              { name: "Folder A", projects: [{ id: "p1", name: "Proj 1" }] },
              { name: "Folder B", projects: [{ id: "p2", name: "Proj 2" }] },
            ],
          },
        ],
      ],
      captured,
    );

    const out = await client.listProjects("c1");

    expect(out).toEqual([
      { id: "p1", name: "Proj 1", folder: "Folder A" },
      { id: "p2", name: "Proj 2", folder: "Folder B" },
    ]);
    expect(captured[0]?.url).toBe(
      "https://console.cloud.ru/u-api/bff-console/v1/simple-projects?customerId=c1",
    );
  });
});

describe("ConsoleApiClient.searchWorkspaces", () => {
  it("POSTs to /organisation/v2/workspaces/search with customer_id + project_id", async () => {
    const captured: Captured[] = [];
    const client = makeClient(
      [["workspaces/search", { total_pages: 1, workspaces: [{ id: "w1", name: "WS", namespace: "ns-1" }] }]],
      captured,
    );

    const out = await client.searchWorkspaces("c1", "p1");

    expect(out).toEqual([{ id: "w1", name: "WS", namespace: "ns-1" }]);
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.url).toBe("https://console.cloud.ru/aicloud/ui/organisation/v2/workspaces/search");
    const body = JSON.parse(captured[0]?.body ?? "{}");
    expect(body).toMatchObject({ customer_id: "c1", project_id: "p1", status: "active" });
  });
});

describe("ConsoleApiClient.listNotebooks", () => {
  it("sends x-workspace-id for workspace-scoped calls", async () => {
    const captured: Captured[] = [];
    const client = makeClient([["notebooks/v2", { notebooks: [] }]], captured);

    await client.listNotebooks({ workspaceId: "w1", workspaceName: "WS" });

    expect(captured[0]?.headers["x-workspace-id"]).toBe("w1");
    expect(captured[0]?.url).toBe(
      "https://console.cloud.ru/aicloud/ui/notebooks/v2/?include_private=true",
    );
  });
});
