import { describe, expect, it } from "vitest";
import { resolveTree } from "../src/parser/tree.js";
import type { RawLine } from "../src/parser/types.js";

interface LineSpec {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  logicalParentUuid?: string;
  isSidechain?: boolean;
  leafUuid?: string;
}

function raw(spec: LineSpec): RawLine {
  return {
    type: spec.type ?? "user",
    uuid: spec.uuid,
    parentUuid: spec.parentUuid ?? null,
    logicalParentUuid: spec.logicalParentUuid,
    isSidechain: spec.isSidechain ?? false,
    timestamp: undefined,
    leafUuid: spec.leafUuid,
    data: {},
  };
}

function uuids(lines: RawLine[]): (string | undefined)[] {
  return lines.map((line) => line.uuid);
}

describe("resolveTree", () => {
  it("walks the parent chain from the last prompt leaf", () => {
    const result = resolveTree([
      raw({ uuid: "a", parentUuid: null }),
      raw({ type: "assistant", uuid: "b", parentUuid: "a" }),
      raw({ uuid: "c", parentUuid: "b" }),
      raw({ type: "last-prompt", leafUuid: "c" }),
    ]);
    expect(uuids(result.branch)).toEqual(["a", "b", "c"]);
    expect(result.stats.leafSource).toBe("last-prompt");
  });

  it("excludes abandoned retry branches and counts them", () => {
    const result = resolveTree([
      raw({ uuid: "a", parentUuid: null }),
      raw({ type: "assistant", uuid: "old", parentUuid: "a" }),
      raw({ type: "assistant", uuid: "new", parentUuid: "a" }),
      raw({ type: "last-prompt", leafUuid: "new" }),
    ]);
    expect(uuids(result.branch)).toEqual(["a", "new"]);
    expect(result.stats.inactiveLines).toBe(1);
  });

  it("uses the last of several last prompt lines", () => {
    const result = resolveTree([
      raw({ uuid: "a", parentUuid: null }),
      raw({ type: "last-prompt", leafUuid: "a" }),
      raw({ type: "assistant", uuid: "b", parentUuid: "a" }),
      raw({ uuid: "c", parentUuid: "b" }),
      raw({ type: "last-prompt", leafUuid: "c" }),
    ]);
    expect(uuids(result.branch)).toEqual(["a", "b", "c"]);
  });

  it("extends forward when response lines already sit below the leaf", () => {
    const result = resolveTree([
      raw({ uuid: "a", parentUuid: null }),
      raw({ type: "last-prompt", leafUuid: "a" }),
      raw({ type: "assistant", uuid: "b", parentUuid: "a" }),
      raw({ type: "assistant", uuid: "c", parentUuid: "b" }),
    ]);
    expect(uuids(result.branch)).toEqual(["a", "b", "c"]);
  });

  it("prefers the newest sibling when extending forward", () => {
    const result = resolveTree([
      raw({ uuid: "a", parentUuid: null }),
      raw({ type: "last-prompt", leafUuid: "a" }),
      raw({ type: "assistant", uuid: "old", parentUuid: "a" }),
      raw({ type: "assistant", uuid: "new", parentUuid: "a" }),
    ]);
    expect(uuids(result.branch)).toEqual(["a", "new"]);
  });

  it("falls back to the last main line when no last prompt exists", () => {
    const result = resolveTree([
      raw({ uuid: "a", parentUuid: null }),
      raw({ type: "assistant", uuid: "b", parentUuid: "a" }),
    ]);
    expect(uuids(result.branch)).toEqual(["a", "b"]);
    expect(result.stats.leafSource).toBe("last-line");
  });

  it("falls back when the last prompt points at a uuid that does not exist", () => {
    const result = resolveTree([
      raw({ uuid: "a", parentUuid: null }),
      raw({ type: "last-prompt", leafUuid: "ghost" }),
    ]);
    expect(uuids(result.branch)).toEqual(["a"]);
    expect(result.stats.leafSource).toBe("last-line");
  });

  it("stops at a missing parent and counts it", () => {
    const result = resolveTree([
      raw({ type: "assistant", uuid: "b", parentUuid: "ghost" }),
      raw({ type: "last-prompt", leafUuid: "b" }),
    ]);
    expect(uuids(result.branch)).toEqual(["b"]);
    expect(result.stats.missingParents).toBe(1);
  });

  it("survives a parent cycle instead of hanging", () => {
    const result = resolveTree([
      raw({ uuid: "a", parentUuid: "b" }),
      raw({ uuid: "b", parentUuid: "a" }),
      raw({ type: "last-prompt", leafUuid: "b" }),
    ]);
    expect(result.branch.length).toBe(2);
  });

  it("returns empty for an empty session", () => {
    const result = resolveTree([]);
    expect(result.branch).toEqual([]);
    expect(result.stats.leafSource).toBe("none");
  });

  it("walks through a compact boundary into the old conversation", () => {
    const result = resolveTree([
      raw({ uuid: "old1", parentUuid: null }),
      raw({ type: "assistant", uuid: "old2", parentUuid: "old1" }),
      raw({
        type: "system",
        uuid: "boundary",
        parentUuid: null,
        logicalParentUuid: "old2",
      }),
      raw({ uuid: "new1", parentUuid: "boundary" }),
      raw({ type: "last-prompt", leafUuid: "new1" }),
    ]);
    expect(uuids(result.branch)).toEqual(["old1", "old2", "boundary", "new1"]);
    expect(result.stats.inactiveLines).toBe(0);
  });

  it("extends forward through a compact boundary from a stale leaf", () => {
    const result = resolveTree([
      raw({ uuid: "old1", parentUuid: null }),
      raw({ type: "last-prompt", leafUuid: "old1" }),
      raw({
        type: "system",
        uuid: "boundary",
        parentUuid: null,
        logicalParentUuid: "old1",
      }),
      raw({ uuid: "new1", parentUuid: "boundary" }),
    ]);
    expect(uuids(result.branch)).toEqual(["old1", "boundary", "new1"]);
  });

  it("groups sidechain lines into their own chains", () => {
    const result = resolveTree([
      raw({ uuid: "a", parentUuid: null }),
      raw({ uuid: "s1", parentUuid: null, isSidechain: true }),
      raw({ type: "assistant", uuid: "s2", parentUuid: "s1", isSidechain: true }),
      raw({ uuid: "t1", parentUuid: null, isSidechain: true }),
      raw({ type: "last-prompt", leafUuid: "a" }),
    ]);
    expect(result.sidechains).toHaveLength(2);
    expect(uuids(result.sidechains[0] ?? [])).toEqual(["s1", "s2"]);
    expect(uuids(result.sidechains[1] ?? [])).toEqual(["t1"]);
  });

  it("keeps sidechain lines out of the main branch and out of the inactive count", () => {
    const result = resolveTree([
      raw({ uuid: "a", parentUuid: null }),
      raw({ uuid: "s1", parentUuid: null, isSidechain: true }),
      raw({ type: "last-prompt", leafUuid: "a" }),
    ]);
    expect(uuids(result.branch)).toEqual(["a"]);
    expect(result.stats.inactiveLines).toBe(0);
  });
});
