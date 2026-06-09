import { describe, expect, it } from "vitest";
import { buildResumeBody, splitImageRef } from "../../src/console/resumeBody";
import type { NotebookHandlerResponse } from "../../src/api/types";

function nb(p: Partial<NotebookHandlerResponse>): NotebookHandlerResponse {
  return {
    uid: "u",
    name: "nb",
    status: "paused",
    image: "cr.ai.cloud.ru/img/base:1.2",
    imageDisplayName: "Base",
    region: "a100-mt",
    author: "a@x",
    is_shared: false,
    portal_ref: "ref",
    ...p,
  } as NotebookHandlerResponse;
}

describe("splitImageRef", () => {
  it("splits name and tag on the last colon", () => {
    expect(splitImageRef("cr.ai.cloud.ru/x/img:1.2")).toEqual({ name: "cr.ai.cloud.ru/x/img", tag: "1.2" });
  });
  it("handles a ref without a tag", () => {
    expect(splitImageRef("plainname")).toEqual({ name: "", tag: "plainname" });
  });
});

describe("buildResumeBody", () => {
  it("builds a harbor image body by default", () => {
    const body = buildResumeBody(
      nb({ name: "train", region: "a100-mt", instanceType: "free.0gpu", imageSource: "harbor", image: "reg/img:v1" }),
    );
    expect(body).toMatchObject({
      name: "train",
      region: "a100-mt",
      instance_type: "free.0gpu",
      allocation_name: null,
      queue_name: null,
      image: { name: "reg/img", tag: "v1", type: "default", source: "harbor" },
    });
  });

  it("builds an artifact_registry image body with authz labels", () => {
    const body = buildResumeBody(nb({ imageSource: "artifact_registry", image: "ar-image-name" }));
    expect(body.image).toEqual({
      name: "ar-image-name",
      labels: { "mlspace.notebook.authz": "v3", "mlspace.notebook.healthz": "v3" },
      source: "artifact_registry",
    });
  });

  it("passes allocation and queue through", () => {
    const body = buildResumeBody(nb({ allocationName: "alloc", allocationQueueName: "q" }));
    expect(body.allocation_name).toBe("alloc");
    expect(body.queue_name).toBe("q");
  });
});
