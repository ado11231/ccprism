import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSessionFile } from "../src/parser/session.js";
import { assembleTranscript } from "../src/render/turns.js";
import type {
  ExtractedSession,
  MessageUsage,
  SessionEvent,
} from "../src/parser/events.js";

function usageEntry(
  messageId: string,
  input: number,
  output = 0,
  model = "claude-opus-4-8",
): MessageUsage {
  return {
    messageId,
    model,
    usage: {
      input,
      output,
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

function user(text: string, isMeta = false): SessionEvent {
  return { kind: "user", text, isMeta, timestamp: undefined };
}

function text(messageId: string, body = "prose"): SessionEvent {
  return {
    kind: "assistant-text",
    text: body,
    model: "claude-opus-4-8",
    messageId,
    timestamp: undefined,
  };
}

function thinking(messageId: string): SessionEvent {
  return { kind: "thinking", text: "hmm", messageId, timestamp: undefined };
}

function call(
  messageId: string,
  toolName: string,
  toolUseId: string,
  input: unknown = {},
): SessionEvent {
  return {
    kind: "tool-call",
    toolName,
    toolUseId,
    description: undefined,
    input,
    messageId,
    timestamp: undefined,
  };
}

function result(toolUseId: string, isError = false): SessionEvent {
  return { kind: "tool-result", toolUseId, text: "out", isError, timestamp: undefined };
}

function session(
  events: SessionEvent[],
  usage: MessageUsage[] = [],
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

describe("assembleTranscript", () => {
  it("groups events into turns anchored at non meta user messages", () => {
    const { turns } = assembleTranscript(
      session([user("first"), text("m1"), user("second"), text("m2")]),
    );
    expect(turns).toHaveLength(2);
    expect(turns[0]?.user?.text).toBe("first");
    expect(turns[0]?.items).toHaveLength(1);
    expect(turns[1]?.user?.text).toBe("second");
    expect(turns[1]?.items).toHaveLength(1);
  });

  it("keeps events before the first user prompt in a turn without a user", () => {
    const { turns } = assembleTranscript(
      session([text("m1"), user("hello"), text("m2")]),
    );
    expect(turns).toHaveLength(2);
    expect(turns[0]?.user).toBeUndefined();
    expect(turns[1]?.user?.text).toBe("hello");
  });

  it("treats meta user lines as items, not turn starts", () => {
    const { turns } = assembleTranscript(
      session([user("hello"), user("caveat", true), text("m1")]),
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]?.items.map((item) => item.kind)).toEqual(["meta", "text"]);
  });

  it("pairs tool results with calls and counts orphans", () => {
    const { turns, stats } = assembleTranscript(
      session([
        user("go"),
        call("m1", "Bash", "t1"),
        result("t1", true),
        result("t9"),
      ]),
    );
    const item = turns[0]?.items[0];
    expect(item?.kind).toBe("tool");
    if (item?.kind === "tool") {
      expect(item.result?.isError).toBe(true);
    }
    expect(stats.orphanResults).toBe(1);
  });

  it("counts each message once in the turn cost", () => {
    const { turns } = assembleTranscript(
      session(
        [user("go"), thinking("m1"), text("m1"), call("m1", "Bash", "t1"), text("m2")],
        [usageEntry("m1", 1_000_000, 100), usageEntry("m2", 1_000_000, 50)],
      ),
    );
    expect(turns[0]?.usd).toBeCloseTo(10.00375, 10);
    expect(turns[0]?.outputTokens).toBe(150);
  });

  it("marks the turn cost unknown when any model is unpriced", () => {
    const { turns } = assembleTranscript(
      session(
        [user("go"), text("m1"), text("m2")],
        [usageEntry("m1", 1_000_000, 100), usageEntry("m2", 1_000_000, 50, "mystery-model")],
      ),
    );
    expect(turns[0]?.usd).toBeUndefined();
    expect(turns[0]?.outputTokens).toBe(150);
  });

  it("splits a message's cost evenly across its calls", () => {
    const { turns } = assembleTranscript(
      session(
        [user("go"), call("m1", "Bash", "t1"), call("m1", "Read", "t2")],
        [usageEntry("m1", 1_000_000)],
      ),
    );
    const items = turns[0]?.items ?? [];
    for (const item of items) {
      expect(item.kind).toBe("tool");
      if (item.kind === "tool") expect(item.usd).toBeCloseTo(2.5, 10);
    }
  });

  it("links a sidechain to the Task call whose prompt matches", () => {
    const { turns, orphanSidechains } = assembleTranscript(
      session(
        [user("go"), call("m1", "Task", "t1", { prompt: "sub work" })],
        [],
        [[user("sub work"), text("s1")]],
      ),
    );
    const item = turns[0]?.items[0];
    expect(item?.kind).toBe("tool");
    if (item?.kind === "tool") {
      expect(item.subagent).toHaveLength(1);
      expect(item.subagent?.[0]?.user?.text).toBe("sub work");
      expect(item.subagent?.[0]?.items).toHaveLength(1);
    }
    expect(orphanSidechains).toHaveLength(0);
  });

  it("claims duplicate prompts in file order", () => {
    const { turns } = assembleTranscript(
      session(
        [
          user("go"),
          call("m1", "Task", "t1", { prompt: "same" }),
          call("m1", "Task", "t2", { prompt: "same" }),
        ],
        [],
        [
          [user("same"), text("s1", "first sidechain")],
          [user("same"), text("s2", "second sidechain")],
        ],
      ),
    );
    const items = turns[0]?.items ?? [];
    const bodies = items.map((item) => {
      if (item.kind !== "tool") return undefined;
      const inner = item.subagent?.[0]?.items[0];
      return inner?.kind === "text" ? inner.event.text : undefined;
    });
    expect(bodies).toEqual(["first sidechain", "second sidechain"]);
  });

  it("returns unclaimed sidechains as assembled orphans", () => {
    const { orphanSidechains } = assembleTranscript(
      session([user("go")], [], [[user("nobody asked"), text("s1")]]),
    );
    expect(orphanSidechains).toHaveLength(1);
    expect(orphanSidechains[0]?.[0]?.user?.text).toBe("nobody asked");
  });
});

describe("assembleTranscript on fixtures", () => {
  it("assembles the basic fixture without loss", async () => {
    const { session: parsed } = await parseSessionFile(
      join(__dirname, "fixtures", "basic.jsonl"),
    );
    const { turns, orphanSidechains, stats } = assembleTranscript(parsed);
    const promptCount = parsed.events.filter(
      (event) => event.kind === "user" && !event.isMeta,
    ).length;
    expect(turns.length).toBeGreaterThanOrEqual(promptCount);
    expect(stats.orphanResults).toBe(0);
    expect(orphanSidechains).toHaveLength(0);
  });

  it("assembles the compact fixture without loss", async () => {
    const { session: parsed } = await parseSessionFile(
      join(__dirname, "fixtures", "compact.jsonl"),
    );
    const { turns, stats } = assembleTranscript(parsed);
    expect(turns.length).toBeGreaterThan(0);
    expect(stats.orphanResults).toBe(0);
    const toolItems = turns
      .flatMap((turn) => turn.items)
      .filter((item) => item.kind === "tool");
    const paired = toolItems.filter(
      (item) => item.kind === "tool" && item.result !== undefined,
    );
    expect(paired.length).toBeGreaterThan(0);
  });
});
