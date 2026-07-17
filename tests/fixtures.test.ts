import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractSession } from "../src/parser/events.js";
import { readSessionFile } from "../src/parser/reader.js";
import { resolveTree } from "../src/parser/tree.js";

// Fixtures are real sessions scrubbed with scripts/scrub.mjs. The
// expected numbers were computed from the originals at scrub time, so
// these tests prove the whole pipeline reads real log shapes and that
// scrubbing changed nothing the parser sees.

const FIXTURES = join(__dirname, "fixtures");

async function parse(name: string) {
  const read = await readSessionFile(join(FIXTURES, name));
  const tree = resolveTree(read.lines);
  const session = extractSession(tree);
  return { read, tree, session };
}

function countKinds(events: { kind: string }[]): Record<string, number> {
  const kinds: Record<string, number> = {};
  for (const event of events) kinds[event.kind] = (kinds[event.kind] ?? 0) + 1;
  return kinds;
}

describe("basic fixture, Claude Code 2.1.207", () => {
  it("parses end to end with the pinned numbers", async () => {
    const { read, tree, session } = await parse("basic.jsonl");

    expect(read.stats.malformedLines).toBe(0);
    expect(read.stats.unknownTypes).toEqual({});
    expect(read.lines).toHaveLength(22);

    expect(tree.stats.leafSource).toBe("last-prompt");
    expect(tree.branch).toHaveLength(19);

    expect(countKinds(session.events)).toEqual({
      user: 3,
      thinking: 3,
      "assistant-text": 3,
    });
    expect(session.usage).toHaveLength(3);
    const output = session.usage.reduce((sum, u) => sum + u.usage.output, 0);
    expect(output).toBe(4708);
    expect(session.meta.models).toEqual(["claude-opus-4-8"]);
    expect(session.meta.version).toBe("2.1.207");
  });
});

describe("compact fixture, Claude Code 2.1.181", () => {
  it("parses end to end with the pinned numbers", async () => {
    const { read, tree, session } = await parse("compact.jsonl");

    expect(read.stats.malformedLines).toBe(0);
    expect(read.stats.unknownTypes).toEqual({});
    expect(read.lines).toHaveLength(505);

    expect(tree.stats.leafSource).toBe("last-prompt");
    expect(tree.branch).toHaveLength(448);
    expect(tree.stats.inactiveLines).toBe(19);

    expect(countKinds(session.events)).toEqual({
      user: 19,
      "assistant-text": 77,
      "tool-call": 109,
      "tool-result": 106,
      thinking: 80,
    });
    expect(session.usage).toHaveLength(104);
    const output = session.usage.reduce((sum, u) => sum + u.usage.output, 0);
    expect(output).toBe(130668);
    expect(session.meta.models).toEqual(["claude-opus-4-8"]);
    expect(session.meta.version).toBe("2.1.181");
  });

  it("stitches the branch across the compact boundary", async () => {
    const { tree } = await parse("compact.jsonl");
    const boundary = tree.branch.find(
      (line) => line.data.subtype === "compact_boundary",
    );
    expect(boundary).toBeDefined();
    const index = tree.branch.indexOf(boundary!);
    expect(index).toBeGreaterThan(0);
    expect(index).toBeLessThan(tree.branch.length - 1);
  });
});

describe("fixture hygiene", () => {
  it("contains no unscrubbed paths or user content", async () => {
    for (const name of ["basic.jsonl", "compact.jsonl"]) {
      const text = await readFile(join(FIXTURES, name), "utf8");
      expect(text).not.toContain("/Users/");
      expect(text).not.toContain("/home/");
      expect(text).not.toContain("adnanalagic");
    }
  });
});
