import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyLines, readSessionFile } from "../src/parser/reader.js";

function line(value: object): string {
  return JSON.stringify(value);
}

describe("classifyLines", () => {
  it("keeps message lines and reads their fields", async () => {
    const result = await classifyLines([
      line({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: "2026-07-17T10:00:00Z",
      }),
      line({ type: "assistant", uuid: "a1", parentUuid: "u1" }),
    ]);

    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toMatchObject({
      type: "user",
      uuid: "u1",
      parentUuid: null,
      isSidechain: false,
      timestamp: "2026-07-17T10:00:00Z",
    });
    expect(result.lines[1]).toMatchObject({ uuid: "a1", parentUuid: "u1" });
    expect(result.stats.keptLines).toBe(2);
  });

  it("keeps system and attachment lines because parent chains pass through them", async () => {
    const result = await classifyLines([
      line({ type: "system", uuid: "s1", parentUuid: "u1" }),
      line({ type: "attachment", uuid: "at1", parentUuid: "s1" }),
    ]);
    expect(result.lines.map((l) => l.type)).toEqual(["system", "attachment"]);
  });

  it("keeps last prompt lines even without a uuid", async () => {
    const result = await classifyLines([
      line({ type: "last-prompt", leafUuid: "leaf-1" }),
    ]);
    expect(result.lines[0]?.leafUuid).toBe("leaf-1");
    expect(result.stats.keptLines).toBe(1);
  });

  it("keeps unknown types that carry a uuid and counts them for doctor", async () => {
    const result = await classifyLines([
      line({ type: "brand-new-thing", uuid: "x1", parentUuid: "u1" }),
    ]);
    expect(result.lines).toHaveLength(1);
    expect(result.stats.unknownTypes).toEqual({ "brand-new-thing": 1 });
  });

  it("drops unknown types without a uuid but still counts them", async () => {
    const result = await classifyLines([
      line({ type: "brand-new-thing", value: 1 }),
      line({ type: "brand-new-thing", value: 2 }),
    ]);
    expect(result.lines).toHaveLength(0);
    expect(result.stats.unknownTypes).toEqual({ "brand-new-thing": 2 });
    expect(result.stats.ignoredLines).toBe(2);
  });

  it("drops known ignorable types and counts them as ignored", async () => {
    const result = await classifyLines([
      line({ type: "ai-title", aiTitle: "some title" }),
      line({ type: "permission-mode", mode: "default" }),
      line({ type: "file-history-snapshot" }),
    ]);
    expect(result.lines).toHaveLength(0);
    expect(result.stats.ignoredLines).toBe(3);
    expect(result.stats.unknownTypes).toEqual({});
  });

  it("counts malformed lines instead of throwing", async () => {
    const result = await classifyLines([
      "{ not json at all",
      line({ noTypeField: true }),
      '"just a string"',
      "[1, 2, 3]",
    ]);
    expect(result.lines).toHaveLength(0);
    expect(result.stats.malformedLines).toBe(4);
  });

  it("skips blank lines without counting them", async () => {
    const result = await classifyLines(["", "   ", line({ type: "user", uuid: "u1" })]);
    expect(result.stats.totalLines).toBe(1);
  });

  it("keeps counts consistent: total equals kept plus ignored plus malformed", async () => {
    const result = await classifyLines([
      line({ type: "user", uuid: "u1" }),
      line({ type: "mode" }),
      "broken",
      line({ type: "mystery" }),
    ]);
    const { totalLines, keptLines, ignoredLines, malformedLines } = result.stats;
    expect(totalLines).toBe(keptLines + ignoredLines + malformedLines);
  });

  it("ignores a non string parentUuid instead of keeping a bad value", async () => {
    const result = await classifyLines([
      line({ type: "user", uuid: "u1", parentUuid: 42 }),
    ]);
    expect(result.lines[0]?.parentUuid).toBeNull();
  });
});

describe("readSessionFile", () => {
  it("reads a jsonl file from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccprism-test-"));
    const path = join(dir, "session.jsonl");
    const content = [
      line({ type: "user", uuid: "u1", parentUuid: null }),
      line({ type: "assistant", uuid: "a1", parentUuid: "u1" }),
      line({ type: "last-prompt", leafUuid: "a1" }),
    ].join("\n");
    await writeFile(path, content + "\n");

    const result = await readSessionFile(path);
    expect(result.lines).toHaveLength(3);
    expect(result.stats.malformedLines).toBe(0);
  });
});
