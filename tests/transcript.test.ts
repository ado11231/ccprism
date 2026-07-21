import { describe, expect, it } from "vitest";
import { emptyRollup, type SessionSummary } from "../src/cost/aggregate.js";
import type {
  ExtractedSession,
  MessageUsage,
  SessionEvent,
} from "../src/parser/events.js";
import { glyphsFor } from "../src/render/glyphs.js";
import { makeStyle } from "../src/render/style.js";
import {
  renderHeader,
  renderTranscript,
  type RenderContext,
} from "../src/render/transcript.js";
import { assembleTranscript } from "../src/render/turns.js";

function usageEntry(messageId: string, input: number, output = 0): MessageUsage {
  return {
    messageId,
    model: "claude-opus-4-8",
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

function user(text: string, timestamp?: string, isMeta = false): SessionEvent {
  return { kind: "user", text, isMeta, timestamp };
}

function text(messageId: string, body: string): SessionEvent {
  return {
    kind: "assistant-text",
    text: body,
    model: "claude-opus-4-8",
    messageId,
    timestamp: undefined,
  };
}

function thinking(messageId: string, body: string): SessionEvent {
  return { kind: "thinking", text: body, messageId, timestamp: undefined };
}

function call(
  toolName: string,
  toolUseId: string,
  input: unknown,
  description?: string,
): SessionEvent {
  return {
    kind: "tool-call",
    toolName,
    toolUseId,
    description,
    input,
    messageId: "m1",
    timestamp: undefined,
  };
}

function result(toolUseId: string, body: string, isError = false): SessionEvent {
  return { kind: "tool-result", toolUseId, text: body, isError, timestamp: undefined };
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

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "3ab55ea1-0000-0000-0000-000000000000",
    projectSlug: "proj",
    filePath: "/tmp/x.jsonl",
    cwd: undefined,
    gitBranch: undefined,
    version: undefined,
    models: ["claude-opus-4-8"],
    firstTimestamp: undefined,
    lastTimestamp: undefined,
    durationMs: 6 * 60_000,
    longestGapMs: undefined,
    turns: 14,
    total: { ...emptyRollup(), usd: 0.42 },
    sidechain: emptyRollup(),
    offBranch: emptyRollup(),
    ...overrides,
  };
}

function ctx(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    c: makeStyle(false),
    g: glyphsFor(false),
    width: 60,
    italic: false,
    color: false,
    full: false,
    costs: false,
    cwd: undefined,
    now: new Date("2026-07-19T12:00:00"),
    ...overrides,
  };
}

function render(
  extracted: ExtractedSession,
  overrides: Partial<RenderContext> = {},
  summaryOverrides: Partial<SessionSummary> = {},
): string[] {
  return renderTranscript(
    assembleTranscript(extracted),
    summary(summaryOverrides),
    ctx(overrides),
  );
}

describe("renderHeader", () => {
  it("shows id, model, cost, turns, and duration", () => {
    const line = renderHeader(summary(), ctx());
    expect(line).toBe("─ session 3ab55ea1 ─  opus-4-8 · $0.42 · 14 turns · 6m");
  });

  it("marks the cost unknown when a model has no pricing", () => {
    const line = renderHeader(
      summary({ total: { ...emptyRollup(), usd: 1, unknownModels: ["x"] } }),
      ctx(),
    );
    expect(line).toContain("$?");
    expect(line).not.toContain("$1.00");
  });
});

describe("renderTranscript", () => {
  it("anchors user messages with glyph, text, and right aligned time", () => {
    const lines = render(
      session([user("help me out", "2026-07-19T04:28:00")]),
    );
    const anchor = lines.find((line) => line.includes("● YOU"));
    expect(anchor).toBeDefined();
    expect(anchor).toMatch(/^● YOU\s+04:28$/);
    expect(lines).toContain("  help me out");
  });

  it("gives claude turns an anchor with a cost badge", () => {
    const lines = render(
      session(
        [user("go"), text("m1", "done")],
        [usageEntry("m1", 1_000_000, 1800)],
      ),
    );
    const anchor = lines.find((line) => line.startsWith("◆ Claude"));
    expect(anchor).toMatch(/1\.8k out · \$5\.04$/);
    expect(lines).toContain("  done");
  });

  it("wraps prose with a hanging indent", () => {
    const lines = render(
      session([user("go"), text("m1", "word ".repeat(30).trim())]),
      { width: 40 },
    );
    const prose = lines.filter((line) => line.startsWith("  word"));
    expect(prose.length).toBeGreaterThan(1);
  });

  it("renders bash calls as bold description over a dim command", () => {
    const lines = render(
      session([
        user("go"),
        call("Bash", "t1", { command: "echo hi && ls" }, "Check things"),
      ]),
    );
    expect(lines).toContain("  ⚡ Check things");
    expect(lines).toContain("     └ echo hi && ls");
  });

  it("labels edits with the path and line delta", () => {
    const lines = render(
      session([
        user("go"),
        call("Edit", "t1", {
          file_path: "/repo/src/a.ts",
          old_string: "x",
          new_string: "y\nz\nw",
        }),
      ]),
      { cwd: "/repo" },
    );
    expect(lines).toContain("  ✎ src/a.ts  (+3 -1)");
  });

  it("truncates a long read path from the front, keeping the file name", () => {
    const lines = render(
      session([
        user("go"),
        call("Read", "t1", {
          file_path: "/very/deeply/nested/directory/tree/importantfile.ts",
        }),
      ]),
      { width: 30 },
    );
    const readLine = lines.find((line) => line.includes("importantfile.ts"));
    expect(readLine).toBeDefined();
    expect(readLine).toContain("…");
  });

  it("collapses thinking to a labeled count", () => {
    const lines = render(
      session([user("go"), thinking("m1", "a\nb\nc")]),
    );
    expect(lines).toContain("  ⋮ thinking (3 lines)");
  });

  it("previews bash output and hides read output", () => {
    const lines = render(
      session([
        user("go"),
        call("Bash", "t1", { command: "seq 5" }, "Count"),
        result("t1", "1\n2\n3\n4\n5"),
        call("Read", "t2", { file_path: "/repo/a.ts" }),
        result("t2", "file contents here"),
      ]),
    );
    expect(lines).toContain("    1");
    expect(lines).toContain("    3");
    expect(lines).not.toContain("    4");
    expect(lines).toContain("    (… 2 more lines)");
    expect(lines).not.toContain("    file contents here");
  });

  it("expands errors in full, always", () => {
    const lines = render(
      session([
        user("go"),
        call("Bash", "t1", { command: "boom" }, "Break"),
        result("t1", "line one\nline two\nline three\nline four", true),
      ]),
    );
    expect(lines).toContain("    line one");
    expect(lines).toContain("    line four");
  });

  it("expands commands, outputs, thinking, and meta with --full", () => {
    const lines = render(
      session([
        user("go"),
        user("meta note", undefined, true),
        thinking("m1", "a\nb"),
        call("Read", "t2", { file_path: "/repo/a.ts" }),
        result("t2", "one\ntwo\nthree\nfour"),
      ]),
      { full: true },
    );
    expect(lines).toContain("  a");
    expect(lines).toContain("  b");
    expect(lines).toContain("  meta note");
    expect(lines).toContain("    four");
  });

  it("hides meta lines by default", () => {
    const lines = render(
      session([user("go"), user("meta note", undefined, true), text("m1", "ok")]),
    );
    expect(lines).not.toContain("  meta note");
  });

  it("adds per call badges with --costs", () => {
    const lines = render(
      session(
        [user("go"), call("Bash", "t1", { command: "ls" }, "List")],
        [usageEntry("m1", 1_000_000)],
      ),
      { costs: true },
    );
    const line = lines.find((entry) => entry.includes("⚡ List"));
    expect(line).toMatch(/\$5\.00$/);
  });

  it("nests subagents one level under their task call", () => {
    const lines = render(
      session(
        [user("go"), call("Task", "t1", { prompt: "sub work", description: "Research" })],
        [],
        [[user("sub work"), text("s1", "found it")]],
      ),
    );
    expect(lines).toContain("  ◎ Research");
    expect(lines).toContain("    ● prompt");
    expect(lines).toContain("      sub work");
    expect(lines).toContain("      found it");
  });

  it("shows unlinked sidechains at the end", () => {
    const lines = render(
      session([user("go"), text("m1", "done")], [], [[user("stray"), text("s1", "out")]]),
    );
    expect(lines).toContain("◎ subagent (unlinked)");
    expect(lines.some((line) => line.includes("● prompt"))).toBe(true);
  });
});

describe("multi line tool labels", () => {
  it("keeps a heredoc bash command on one line", () => {
    const built = assembleTranscript(
      session([
        user("go"),
        call("Bash", "t1", { command: "python3 - <<'EOF'\nimport re\nprint(1)" }),
        result("t1", "1"),
      ]),
    );
    const lines = renderTranscript(built, summary(), ctx());
    const label = lines.find((line) => line.includes("python3"));
    expect(label).toBeDefined();
    expect(label).not.toContain("import re");
    expect(lines.every((line) => !line.startsWith("import"))).toBe(true);
  });
});
