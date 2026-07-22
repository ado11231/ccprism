import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runView, type ViewFlags } from "../src/commands/view.js";
import type {
  ExtractedSession,
  MessageUsage,
  SessionEvent,
} from "../src/parser/events.js";
import { parseSessionFile } from "../src/parser/session.js";
import { glyphsFor } from "../src/render/glyphs.js";
import { makeStyle } from "../src/render/style.js";
import {
  renderFollowBody,
  type RenderContext,
} from "../src/render/transcript.js";
import { assembleTranscript, settledTurns } from "../src/render/turns.js";

const FIXTURES = join(__dirname, "fixtures");
const COMPACT = join(FIXTURES, "compact.jsonl");

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function loggedLines(): string[] {
  return logSpy.mock.calls.flatMap((call) => call.join(" ").split("\n"));
}

function errored(): string {
  return errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
}

function usageEntry(messageId: string, output = 100): MessageUsage {
  return {
    messageId,
    model: "claude-opus-4-8",
    usage: {
      input: 10,
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

function user(text: string): SessionEvent {
  return { kind: "user", text, isMeta: false, timestamp: undefined };
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

function call(messageId: string, toolUseId: string, path: string): SessionEvent {
  return {
    kind: "tool-call",
    toolName: "Read",
    toolUseId,
    description: undefined,
    input: { file_path: path },
    messageId,
    timestamp: undefined,
  };
}

function result(toolUseId: string): SessionEvent {
  return {
    kind: "tool-result",
    toolUseId,
    text: "out",
    isError: false,
    timestamp: undefined,
  };
}

function session(
  events: SessionEvent[],
  usage: MessageUsage[] = [],
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
    sidechains: [],
    usage,
    stats: { unknownBlocks: 0 },
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

describe("settledTurns", () => {
  it("holds back a tool call that has no result yet", () => {
    const { turns } = assembleTranscript(
      session([user("go"), text("m1"), call("m1", "t1", "/a.ts")]),
    );
    expect(turns[0]?.items).toHaveLength(2);
    expect(settledTurns(turns)[0]?.items).toHaveLength(1);
  });

  it("releases the call once its result lands", () => {
    const { turns } = assembleTranscript(
      session([user("go"), text("m1"), call("m1", "t1", "/a.ts"), result("t1")]),
    );
    expect(settledTurns(turns)[0]?.items).toHaveLength(2);
  });

  it("cuts at the first pending call, not around it", () => {
    // A message with parallel calls writes both calls before either
    // result. Emitting the second call before the first result lands
    // would leave the result nowhere correct to go.
    const { turns } = assembleTranscript(
      session([
        user("go"),
        call("m1", "t1", "/a.ts"),
        call("m1", "t2", "/b.ts"),
        result("t2"),
      ]),
    );
    expect(settledTurns(turns)[0]?.items).toHaveLength(0);
  });

  it("leaves finished turns whole even when a call never resolved", () => {
    // An interrupted call in an earlier turn is settled: the turn is
    // over, so waiting on it would freeze the stream forever.
    const { turns } = assembleTranscript(
      session([user("one"), call("m1", "t1", "/a.ts"), user("two"), text("m2")]),
    );
    const settled = settledTurns(turns);
    expect(settled).toHaveLength(2);
    expect(settled[0]?.items).toHaveLength(1);
  });

  it("passes an empty transcript through", () => {
    expect(settledTurns([])).toEqual([]);
  });
});

describe("renderFollowBody", () => {
  const built = assembleTranscript(
    session(
      [user("one"), text("m1"), user("two"), text("m2")],
      [usageEntry("m1"), usageEntry("m2")],
    ),
  );

  it("puts no cost badge on the live turn's anchor", () => {
    const lines = renderFollowBody(built.turns, ctx());
    const anchors = lines.filter((line) => line.includes("Claude"));
    expect(anchors).toHaveLength(2);
    // The first turn settled, so its cost rides a closing line, not
    // the anchor. The last turn is live and has no cost line at all.
    expect(anchors.every((line) => !line.includes("$"))).toBe(true);
    expect(lines.filter((line) => line.includes("$"))).toHaveLength(1);
  });

  it("closes a settled turn with its cost", () => {
    const lines = renderFollowBody(built.turns, ctx());
    const badge = lines[lines.indexOf("  prose") + 1];
    expect(badge).toMatch(/100 out . \$\d/);
    expect(badge?.startsWith(" ")).toBe(true);
  });

  it("finalize closes the last turn too", () => {
    const lines = renderFollowBody(built.turns, ctx(), true);
    expect(lines.filter((line) => line.includes("$"))).toHaveLength(2);
  });

  it("gives a bare prompt no closing badge", () => {
    const bare = assembleTranscript(session([user("one"), user("two")]));
    const lines = renderFollowBody(bare.turns, ctx(), true);
    expect(lines.some((line) => line.includes("$"))).toBe(false);
  });
});

// The property the whole command rests on: printed lines are final,
// so feeding the renderer more of the same log should only add lines
// to the end. This replays a real session in growing prefixes and
// measures how well that holds.
//
// It holds almost always, not always. The tree resolver extends the
// branch forward past the leaf, guessing that the newest sibling
// wins, because a live file already holds assistant lines the last
// prompt line does not know about. A later last-prompt line can name
// a leaf on the other side of a fork, and content that was on the
// branch drops off it. That is what the stale notice is for, and the
// numbers here are the budget: rewrites must stay rare enough that
// the transcript reads as an append log.
describe("append only property", () => {
  it("grows monotonically across a real session, rewriting rarely", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccprism-follow-grow-"));
    const file = join(root, "grow.jsonl");
    const all = (await readFile(COMPACT, "utf8")).split("\n").filter((l) => l !== "");
    const view = ctx();

    let previous: string[] = [];
    let grew = 0;
    let rewrote = 0;
    let passes = 0;
    // Every eighth prefix keeps the replay quick while still landing
    // between calls and their results.
    for (let n = 1; n <= all.length; n += 8) {
      await writeFile(file, `${all.slice(0, n).join("\n")}\n`);
      const parsed = await parseSessionFile(file);
      const lines = renderFollowBody(
        settledTurns(assembleTranscript(parsed.session).turns),
        view,
      );
      passes += 1;
      if (previous.every((line, i) => lines[i] === line)) {
        if (lines.length > previous.length) grew += 1;
      } else {
        rewrote += 1;
      }
      previous = lines;
    }
    // The replay has to actually produce output, or the checks above
    // pass on nothing.
    expect(grew).toBeGreaterThan(5);
    expect(previous.length).toBeGreaterThan(50);
    expect(rewrote / passes).toBeLessThan(0.05);
  });
});

function flags(root: string, extra: Partial<ViewFlags> = {}): ViewFlags {
  return {
    json: false,
    color: false,
    project: undefined,
    since: undefined,
    until: undefined,
    root,
    id: undefined,
    full: false,
    costs: false,
    ascii: false,
    follow: true,
    compact: false,
    ...extra,
  };
}

async function growingRoot(lines: number): Promise<{ root: string; file: string; all: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "ccprism-follow-"));
  const project = join(root, "-scrubbed-project");
  await mkdir(project);
  const file = join(project, "11111111-aaaa-bbbb-cccc-000000000001.jsonl");
  const all = (await readFile(COMPACT, "utf8")).split("\n").filter((l) => l !== "");
  await writeFile(file, `${all.slice(0, lines).join("\n")}\n`);
  return { root, file, all };
}

describe("view --follow", () => {
  it("opens with a live header and no session totals", async () => {
    const { root } = await growingRoot(60);
    const code = await runView(flags(root), { once: true });
    expect(code).toBe(0);
    const first = loggedLines()[0] ?? "";
    expect(first).toContain("session");
    expect(first).toContain("live");
    expect(first).not.toContain("$");
    expect(errored()).toContain("following");
    expect(errored()).toContain("ctrl-c");
  });

  it("rejects --json for now and exits 2", async () => {
    const { root } = await growingRoot(60);
    const code = await runView(flags(root, { json: true }), { once: true });
    expect(code).toBe(2);
    expect(errored()).toContain("--json");
  });

  it("reports a missing session the same way view does", async () => {
    const { root } = await growingRoot(60);
    const code = await runView(flags(root, { id: "9999" }), { once: true });
    expect(code).toBe(2);
    expect(errored()).toContain("9999");
  });

  it("appends new turns as the file grows, then closes with the totals", async () => {
    const { root, file, all } = await growingRoot(60);

    async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (fn()) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error("timed out waiting for condition");
    }

    const controller = new AbortController();
    const run = runView(flags(root), {
      intervalMs: 15,
      signal: controller.signal,
    });

    await waitFor(() => loggedLines().length > 1);
    const opening = loggedLines();

    await writeFile(file, `${all.slice(0, 400).join("\n")}\n`);
    await waitFor(() => loggedLines().length > opening.length + 10);

    // Everything printed before is still exactly what was printed:
    // the stream appends, it never rewrites.
    expect(loggedLines().slice(0, opening.length)).toEqual(opening);
    expect(loggedLines().some((line) => line.includes("stale"))).toBe(false);

    controller.abort();
    expect(await run).toBe(0);

    // The closing line is the header with its numbers, true at last.
    const last = loggedLines().at(-1) ?? "";
    expect(last).toContain("session");
    expect(last).toContain("turns");
    expect(last).toMatch(/\$\d/);
  });

  it("says so when the log is rewritten under it", async () => {
    const { root, file, all } = await growingRoot(400);
    const controller = new AbortController();
    const run = runView(flags(root), {
      intervalMs: 15,
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 60));

    // A different conversation in the same file: what is on screen
    // cannot be taken back, so it has to be called stale.
    await writeFile(file, `${all.slice(0, 20).join("\n")}\n`);
    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (loggedLines().some((line) => line.includes("stale"))) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    controller.abort();
    await run;
    expect(loggedLines().some((line) => line.includes("stale"))).toBe(true);
  });
});
