import { describe, expect, it } from "vitest";
import { buildKernelBaseUrl } from "../../src/jupyter/kernelUrl";

describe("buildKernelBaseUrl", () => {
  it("joins the shim base URL with the pod base_url prefix", () => {
    expect(buildKernelBaseUrl("http://127.0.0.1:8899", "/a100-mt/notebook/abc/")).toBe(
      "http://127.0.0.1:8899/a100-mt/notebook/abc/",
    );
  });

  it("normalizes missing leading/trailing slashes", () => {
    expect(buildKernelBaseUrl("http://127.0.0.1:5000", "a100-mt/notebook/abc")).toBe(
      "http://127.0.0.1:5000/a100-mt/notebook/abc/",
    );
  });
});
