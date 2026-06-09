import { describe, expect, it } from "vitest";
import {
  describeFilter,
  distinctAuthors,
  filterNotebooks,
  isFilterActive,
} from "../../src/views/notebookFilter";
import type { NotebookHandlerResponse } from "../../src/api/types";

function nb(partial: Partial<NotebookHandlerResponse>): NotebookHandlerResponse {
  return {
    uid: "u",
    name: "nb",
    status: "running",
    image: "img",
    imageDisplayName: "Image",
    region: "a100",
    author: "alice@x",
    is_shared: false,
    portal_ref: "ref",
    ...partial,
  } as NotebookHandlerResponse;
}

const list = [
  nb({ uid: "1", name: "train-resnet", author: "alice@x", creationTimestamp: 100 }),
  nb({ uid: "2", name: "eda-notebook", author: "bob@x", creationTimestamp: 300 }),
  nb({ uid: "3", name: "train-bert", author: "bob@x", creationTimestamp: 200 }),
];

const noFav = () => false;

describe("filterNotebooks", () => {
  it("filters by case-insensitive name substring", () => {
    const out = filterNotebooks(list, { search: "TRAIN" }, noFav).map((n) => n.uid);
    expect(out.sort()).toEqual(["1", "3"]);
  });

  it("filters by exact author", () => {
    const out = filterNotebooks(list, { author: "bob@x" }, noFav).map((n) => n.uid);
    expect(out.sort()).toEqual(["2", "3"]);
  });

  it("filters favorites only", () => {
    const isFav = (uid: string) => uid === "3";
    expect(filterNotebooks(list, { favoritesOnly: true }, isFav).map((n) => n.uid)).toEqual(["3"]);
  });

  it("sorts favorites first, then newest by creationTimestamp", () => {
    const isFav = (uid: string) => uid === "1";
    expect(filterNotebooks(list, {}, isFav).map((n) => n.uid)).toEqual(["1", "2", "3"]);
  });

  it("combines filters", () => {
    const out = filterNotebooks(list, { search: "train", author: "bob@x" }, noFav).map((n) => n.uid);
    expect(out).toEqual(["3"]);
  });
});

describe("distinctAuthors", () => {
  it("returns sorted unique authors", () => {
    expect(distinctAuthors(list)).toEqual(["alice@x", "bob@x"]);
  });
});

describe("isFilterActive / describeFilter", () => {
  it("detects active filters", () => {
    expect(isFilterActive({})).toBe(false);
    expect(isFilterActive({ search: "  " })).toBe(false);
    expect(isFilterActive({ author: "bob@x" })).toBe(true);
  });

  it("describes the active filter", () => {
    expect(describeFilter({})).toBeUndefined();
    expect(describeFilter({ author: "bob@x", favoritesOnly: true })).toContain("author: bob@x");
  });
});
