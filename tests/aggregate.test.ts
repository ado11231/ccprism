import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addToRollup,
  dayOf,
  emptyRollup,
  rollupByKey,
  rollupOf,
  summarizeSession,
} from "../src/cost/aggregate.js";
import type { MessageUsage } from "../src/parser/events.js";
import { parseSessionFile } from "../src/parser/session.js";

function entry(partial: Partial<MessageUsage>): MessageUsage {
  return {
    messageId: "msg_x",
    model: "claude-opus-4-8",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreationTotal: 0,
      cacheCreation5m: undefined,
      cacheCreation1h: undefined,
    },
    isSidechain: false,
    onActiveBranch: true,
    timestamp: undefined,
    ...partial,
  };
}

describe("rollups", () => {
  it("sums tokens and cost across entries", () => {
    const rollup = rollupOf([
      entry({ usage: { ...entry({}).usage, input: 1_000_000 } }),
      entry({ usage: { ...entry({}).usage, output: 1_000_000 } }),
    ]);
    expect(rollup.messages).toBe(2);
    expect(rollup.tokens.input).toBe(1_000_000);
    expect(rollup.tokens.output).toBe(1_000_000);
    expect(rollup.usd).toBeCloseTo(30, 10);
    expect(rollup.unknownModels).toEqual([]);
  });

  it("counts tokens for unknown models but excludes them from usd", () => {
    const rollup = emptyRollup();
    addToRollup(
      rollup,
      entry({ model: "claude-future-9", usage: { ...entry({}).usage, input: 500 } }),
    );
    addToRollup(
      rollup,
      entry({ model: "claude-future-9", usage: { ...entry({}).usage, input: 500 } }),
    );
    expect(rollup.tokens.input).toBe(1000);
    expect(rollup.usd).toBe(0);
    expect(rollup.unknownModels).toEqual(["claude-future-9"]);
  });

  it("counts unsplit cache write totals at the 5m tier", () => {
    const rollup = rollupOf([
      entry({ usage: { ...entry({}).usage, cacheCreationTotal: 700 } }),
    ]);
    expect(rollup.tokens.cacheWrite5m).toBe(700);
    expect(rollup.tokens.cacheWrite1h).toBe(0);
  });

  it("groups by key and drops undefined keys", () => {
    const groups = rollupByKey(
      [
        entry({ model: "claude-opus-4-8" }),
        entry({ model: "claude-opus-4-8" }),
        entry({ model: "claude-fable-5" }),
      ],
      (e) => (e.model === "claude-fable-5" ? undefined : e.model),
    );
    expect([...groups.keys()]).toEqual(["claude-opus-4-8"]);
    expect(groups.get("claude-opus-4-8")?.messages).toBe(2);
  });
});

describe("dayOf", () => {
  it("uses the local calendar day", () => {
    // Local noon, so the answer is the same in every timezone.
    const stamp = new Date(2026, 6, 17, 12, 0, 0).toISOString();
    expect(dayOf(stamp)).toBe("2026-07-17");
  });

  it("returns undefined for missing or invalid timestamps", () => {
    expect(dayOf(undefined)).toBeUndefined();
    expect(dayOf("not a date")).toBeUndefined();
  });
});

describe("summarizeSession on the compact fixture", () => {
  it("matches the pinned numbers", async () => {
    const filePath = join(__dirname, "fixtures", "compact.jsonl");
    const { session } = await parseSessionFile(filePath);
    const summary = summarizeSession(
      { filePath, projectSlug: "-scrubbed-project" },
      session,
    );

    expect(summary.total.messages).toBe(104);
    expect(summary.total.unknownModels).toEqual([]);
    expect(summary.total.usd).toBeGreaterThan(0);
    expect(summary.models).toEqual(["claude-opus-4-8"]);
    expect(summary.turns).toBeGreaterThan(0);
    expect(summary.turns).toBeLessThanOrEqual(19);
    expect(summary.durationMs).toBeGreaterThan(0);
    // Subsets never exceed the total.
    expect(summary.sidechain.messages).toBeLessThanOrEqual(summary.total.messages);
    expect(summary.offBranch.messages).toBeLessThanOrEqual(summary.total.messages);
  });
});
