import { describe, expect, it } from "vitest";
import {
  mergeToolBreakdowns,
  toolBreakdown,
  toolCategory,
} from "../src/cost/tools.js";
import type {
  ExtractedSession,
  MessageUsage,
  SessionEvent,
} from "../src/parser/events.js";

function usageEntry(messageId: string, input: number): MessageUsage {
  return {
    messageId,
    model: "claude-opus-4-8",
    usage: {
      input,
      output: 0,
      cacheRead: 0,
      cacheCreationTotal: 0,
      cacheCreation5m: undefined,
      cacheCreation1h: undefined,
    },
    isSidechain: false,
    onActiveBranch: true,
    timestamp: undefined,
  };
}

function call(messageId: string, toolName: string, toolUseId: string): SessionEvent {
  return {
    kind: "tool-call",
    toolName,
    toolUseId,
    description: undefined,
    input: {},
    messageId,
    timestamp: undefined,
  };
}

function result(toolUseId: string, isError: boolean): SessionEvent {
  return { kind: "tool-result", toolUseId, text: "", isError, timestamp: undefined };
}

function session(
  events: SessionEvent[],
  usage: MessageUsage[],
  sidechains: SessionEvent[][] = [],
): ExtractedSession {
  return {
    meta: {
      sessionId: undefined,
      version: undefined,
      cwd: undefined,
      gitBranch: undefined,
      firstTimestamp: undefined,
      lastTimestamp: undefined,
      models: [],
    },
    events,
    sidechains,
    usage,
    stats: { unknownBlocks: 0 },
  };
}

describe("toolCategory", () => {
  it("maps names into glyph families", () => {
    expect(toolCategory("Bash")).toBe("bash");
    expect(toolCategory("Edit")).toBe("edit");
    expect(toolCategory("Write")).toBe("edit");
    expect(toolCategory("Grep")).toBe("read");
    expect(toolCategory("WebSearch")).toBe("web");
    expect(toolCategory("Task")).toBe("agents");
    expect(toolCategory("mcp__github__create_pr")).toBe("mcp");
    expect(toolCategory("TodoWrite")).toBe("other");
  });
});

describe("toolBreakdown", () => {
  it("counts calls and failures per category", () => {
    const s = session(
      [
        call("m1", "Bash", "t1"),
        call("m1", "Bash", "t2"),
        call("m2", "Read", "t3"),
        result("t1", true),
        result("t2", false),
        result("t3", false),
      ],
      [usageEntry("m1", 1_000_000), usageEntry("m2", 1_000_000)],
    );
    const breakdown = toolBreakdown(s);
    expect(breakdown.get("bash")).toEqual({ calls: 2, failures: 1, usd: 5 });
    expect(breakdown.get("read")).toEqual({ calls: 1, failures: 0, usd: 5 });
  });

  it("splits a message's cost evenly across its calls", () => {
    const s = session(
      [call("m1", "Bash", "t1"), call("m1", "Read", "t2")],
      [usageEntry("m1", 1_000_000)],
    );
    const breakdown = toolBreakdown(s);
    expect(breakdown.get("bash")?.usd).toBeCloseTo(2.5, 10);
    expect(breakdown.get("read")?.usd).toBeCloseTo(2.5, 10);
  });

  it("attributes messages without tool calls to chat", () => {
    const s = session([], [usageEntry("m1", 1_000_000)]);
    expect(toolBreakdown(s).get("chat")?.usd).toBe(5);
  });

  it("includes sidechain events", () => {
    const s = session(
      [],
      [usageEntry("m1", 1_000_000)],
      [[call("m1", "Bash", "t1")]],
    );
    expect(toolBreakdown(s).get("bash")?.calls).toBe(1);
    expect(toolBreakdown(s).get("bash")?.usd).toBe(5);
  });

  it("honors the allowed message id filter", () => {
    const s = session(
      [call("m1", "Bash", "t1"), call("m2", "Read", "t2")],
      [usageEntry("m1", 1_000_000), usageEntry("m2", 1_000_000)],
    );
    const breakdown = toolBreakdown(s, new Set(["m1"]));
    expect(breakdown.get("bash")?.calls).toBe(1);
    expect(breakdown.has("read")).toBe(false);
  });

  it("merges breakdowns", () => {
    const a = toolBreakdown(
      session([call("m1", "Bash", "t1")], [usageEntry("m1", 1_000_000)]),
    );
    const b = toolBreakdown(
      session([call("m2", "Bash", "t2")], [usageEntry("m2", 1_000_000)]),
    );
    mergeToolBreakdowns(a, b);
    expect(a.get("bash")).toEqual({ calls: 2, failures: 0, usd: 10 });
  });
});
