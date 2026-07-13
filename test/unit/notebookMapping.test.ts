import { describe, expect, it } from "vitest";
import { autoshutdownModes, mapConsoleNotebook, normalizeStatus } from "../../src/console/notebookMapping";

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

describe("normalizeStatus", () => {
  it.each(["creating", "running", "paused_by_timer", "error", "fixing", "unknown"] as const)(
    "passes the known status %s through unchanged",
    (status) => {
      expect(normalizeStatus(status)).toBe(status);
    },
  );

  it.each<[string, string | undefined]>([
    ["an unrecognized string", "totally-made-up"],
    ["a case variant of a known status", "Running"],
    ["an empty string", ""],
    ["undefined", undefined],
  ])("normalizes %s to 'unknown'", (_desc, raw) => {
    expect(normalizeStatus(raw)).toBe("unknown");
  });
});

describe("mapConsoleNotebook status fallback", () => {
  it("maps an unrecognized status to 'unknown' and reports the raw value once", () => {
    const seen: string[] = [];
    const out = mapConsoleNotebook(
      { uid: "u", name: "n", status: "weird-status", region: "r" },
      (raw) => seen.push(raw),
    );
    expect(out.status).toBe("unknown");
    expect(seen).toEqual(["weird-status"]);
  });

  it("does not invoke the callback for a known status", () => {
    const seen: string[] = [];
    const out = mapConsoleNotebook(
      { uid: "u", name: "n", status: "running", region: "r" },
      (raw) => seen.push(raw),
    );
    expect(out.status).toBe("running");
    expect(seen).toEqual([]);
  });

  it("normalizes an empty status to 'unknown' without reporting a raw value", () => {
    const seen: string[] = [];
    const out = mapConsoleNotebook(
      { uid: "u", name: "n", status: "", region: "r" },
      (raw) => seen.push(raw),
    );
    expect(out.status).toBe("unknown");
    expect(seen).toEqual([]);
  });

  it("still maps an unknown status when no callback is supplied", () => {
    const out = mapConsoleNotebook({ uid: "u", name: "n", status: "nope", region: "r" });
    expect(out.status).toBe("unknown");
  });
});

describe("mapConsoleNotebook field mapping (3.7)", () => {
  it("renames access_mode/access_granted/autoshutdown_config and carries pause_at", () => {
    const out = mapConsoleNotebook({
      uid: "u",
      name: "n",
      status: "running",
      region: "r",
      access_mode: "shared",
      access_granted: false,
      pause_at: "2026-01-02T03:04:05Z",
      autoshutdown_config: { by_timer: {} },
    });
    expect(out.accessMode).toBe("shared");
    expect(out.accessGranted).toBe(false);
    expect(out.pause_at).toBe("2026-01-02T03:04:05Z");
    expect(out.autoshutdownModes).toEqual(["по времени"]);
  });

  it.each<[string, boolean | undefined, boolean]>([
    ["explicit false denies access", false, false],
    ["explicit true grants access", true, true],
    ["an omitted flag is treated as access granted", undefined, true],
  ])("access_granted: %s", (_desc, raw, expected) => {
    const out = mapConsoleNotebook({
      uid: "u",
      name: "n",
      status: "running",
      region: "r",
      ...(raw === undefined ? {} : { access_granted: raw }),
    });
    expect(out.accessGranted).toBe(expected);
  });
});

describe("autoshutdownModes", () => {
  it.each<[string, unknown]>([
    ["undefined", undefined],
    ["null", null],
    ["a string", "by_timer"],
    ["a number", 42],
    ["a boolean", true],
    ["an empty object", {}],
  ])("returns [] for non-config input: %s", (_desc, input) => {
    expect(autoshutdownModes(input)).toEqual([]);
  });

  it("counts a present sub-config that lacks the flag as enabled", () => {
    expect(autoshutdownModes({ by_timer: {} })).toEqual(["по времени"]);
  });

  it("counts a sub-config with shutdown_enabled: true", () => {
    expect(autoshutdownModes({ by_schedule: { shutdown_enabled: true } })).toEqual(["по расписанию"]);
  });

  it("excludes a sub-config explicitly disabled with shutdown_enabled: false", () => {
    expect(autoshutdownModes({ by_load: { shutdown_enabled: false } })).toEqual([]);
  });

  it("emits all three labels in timer/schedule/load order regardless of key order", () => {
    expect(autoshutdownModes({ by_load: {}, by_schedule: {}, by_timer: {} })).toEqual([
      "по времени",
      "по расписанию",
      "по нагрузке",
    ]);
  });

  it("keeps enabled modes and drops disabled ones in a mixed config", () => {
    expect(
      autoshutdownModes({
        by_timer: {},
        by_schedule: { shutdown_enabled: false },
        by_load: { shutdown_enabled: true },
      }),
    ).toEqual(["по времени", "по нагрузке"]);
  });

  it("does not count a present key whose sub-config is not an object", () => {
    expect(autoshutdownModes({ by_timer: null, by_schedule: "x", by_load: 0 })).toEqual([]);
  });

  it("treats a non-boolean shutdown_enabled as disabled (strict === true)", () => {
    expect(autoshutdownModes({ by_timer: { shutdown_enabled: "true" } })).toEqual([]);
  });
});
