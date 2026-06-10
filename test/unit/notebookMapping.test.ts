import { describe, expect, it } from "vitest";
import { mapConsoleNotebook } from "../../src/console/notebookMapping";

describe("mapConsoleNotebook", () => {
  it("maps console fields to the view model", () => {
    const out = mapConsoleNotebook({
      uid: "u1",
      name: "nb",
      status: "running",
      url: "https://k2-nb.ai.cloud.ru/a100-mt/notebook/u1/",
      image: "img",
      imageDisplayName: "Image X",
      instanceType: "free.0gpu",
      region: "a100-mt",
      author: "alice@x",
      is_shared: true,
      portal_ref: "ref",
      namespace: "ns-1",
      creationTimestamp: 100,
    });
    expect(out).toMatchObject({
      uid: "u1",
      name: "nb",
      status: "running",
      url: "https://k2-nb.ai.cloud.ru/a100-mt/notebook/u1/",
      imageDisplayName: "Image X",
      region: "a100-mt",
      namespace: "ns-1",
      creationTimestamp: 100,
    });
  });

  it("derives creationTimestamp from created_at when the numeric field is absent", () => {
    const out = mapConsoleNotebook({
      uid: "u",
      name: "n",
      status: "paused",
      region: "a100",
      created_at: "2026-01-02T03:04:05",
    });
    expect(out.creationTimestamp).toBe(Math.floor(Date.UTC(2026, 0, 2, 3, 4, 5) / 1000));
  });

  it("falls back imageDisplayName to image and tolerates missing optionals", () => {
    const out = mapConsoleNotebook({ uid: "u", name: "n", status: "creating", region: "r", image: "only-image" });
    expect(out.imageDisplayName).toBe("only-image");
    expect(out.url).toBeNull();
    expect(out.is_shared).toBe(false);
  });
});
