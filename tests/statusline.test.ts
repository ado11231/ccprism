import { copyFile, mkdir, mkdtemp, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyRollup, type SessionSummary } from "../src/cost/aggregate.js";
import { runStatusline } from "../src/commands/statusline.js";
import type { CommandFlags } from "../src/commands/load.js";
import { currentContext, statuslineText } from "../src/render/live.js";
import { parseSessionFile } from "../src/parser/session.js";

const FIXTURES = join(__dirname, "fixtures");
const BASIC = join(FIXTURES, "basic.jsonl");

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function logged(): string {
  return logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
}

function flags(extra: Partial<CommandFlags> = {}): CommandFlags {
  return {
    json: false,
    color: false,
    project: undefined,
    since: undefined,
    until: undefined,
    ...extra,
  };
}

function summary(extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "abc123",
    projectSlug: "p",
    filePath: "/x.jsonl",
    cwd: undefined,
    gitBranch: undefined,
    version: undefined,
    models: ["claude-opus-4-8"],
    firstTimestamp: undefined,
    lastTimestamp: undefined,
    durationMs: undefined,
    longestGapMs: undefined,
    turns: 3,
    total: emptyRollup(),
    sidechain: emptyRollup(),
    offBranch: emptyRollup(),
    ...extra,
  };
}

// Two fixtures under a projects-root layout, basic the newer one.
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ccprism-status-"));
  const project = join(root, "-scrubbed-project");
  await mkdir(project);
  const newer = join(project, "11111111-aaaa-bbbb-cccc-000000000001.jsonl");
  await copyFile(BASIC, newer);
  const now = Date.now() / 1000;
  await utimes(newer, now, now);
  return root;
}

describe("statuslineText", () => {
  it("joins model, cost, context, and turns", () => {
    const s = summary({ total: { ...emptyRollup(), usd: 1.24 } });
    const line = statuslineText(s, {
      tokens: 27800,
      model: "claude-opus-4-8",
    });
    expect(line).toBe("opus-4-8 · $1.24 · 27.8k ctx · 3 turns");
  });

  it("singularizes a lone turn", () => {
    const s = summary({ turns: 1, total: { ...emptyRollup(), usd: 0.1 } });
    expect(statuslineText(s, { tokens: 0, model: undefined })).toContain(
      "1 turn",
    );
    expect(statuslineText(s, { tokens: 0, model: undefined })).not.toContain(
      "turns",
    );
  });

  it("marks cost unknown when a model has no pricing", () => {
    const s = summary({
      total: { ...emptyRollup(), usd: 0, unknownModels: ["mystery"] },
    });
    expect(statuslineText(s, { tokens: 100, model: "mystery" })).toContain("$?");
  });

  it("omits the context segment when nothing has been sent yet", () => {
    const line = statuslineText(summary(), { tokens: 0, model: undefined });
    expect(line).not.toContain("ctx");
  });

  it("falls back to the session's model when context has none", () => {
    const line = statuslineText(summary(), { tokens: 5, model: undefined });
    expect(line).toContain("opus-4-8");
  });
});

describe("currentContext", () => {
  it("reports the input side of the latest main-thread call", async () => {
    const parsed = await parseSessionFile(BASIC);
    const context = currentContext(parsed.session);
    expect(context.tokens).toBeGreaterThan(0);
    expect(context.model).toBe("claude-opus-4-8");
  });
});

describe("runStatusline", () => {
  it("renders the session named by transcript_path on stdin", async () => {
    const code = await runStatusline(flags(), {
      stdin: JSON.stringify({ transcript_path: BASIC }),
    });
    expect(code).toBe(0);
    expect(logged()).toContain("opus-4-8");
    expect(logged()).toContain("ctx");
    expect(logged()).toContain("turns");
  });

  it("emits a json object with source stdin", async () => {
    const code = await runStatusline(flags({ json: true }), {
      stdin: JSON.stringify({ transcript_path: BASIC }),
    });
    expect(code).toBe(0);
    const out = JSON.parse(logged());
    expect(out.source).toBe("stdin");
    expect(out.turns).toBeGreaterThan(0);
    expect(out.contextTokens).toBeGreaterThan(0);
    expect(typeof out.usd).toBe("number");
  });

  it("falls back to the newest session with no stdin", async () => {
    const root = await makeRoot();
    const code = await runStatusline(flags({ json: true, root }), {
      stdin: undefined,
    });
    expect(code).toBe(0);
    expect(JSON.parse(logged()).source).toBe("latest");
  });

  it("stays quiet and exits 0 when transcript_path does not resolve", async () => {
    const code = await runStatusline(flags(), {
      stdin: JSON.stringify({ transcript_path: "/no/such/file.jsonl" }),
    });
    expect(code).toBe(0);
    expect(logged()).toBe("");
  });

  it("tolerates non-json on stdin and falls back", async () => {
    const root = await makeRoot();
    const code = await runStatusline(flags({ json: true, root }), {
      stdin: "not json at all",
    });
    expect(code).toBe(0);
    expect(JSON.parse(logged()).source).toBe("latest");
  });

  it("errors and exits 2 when run by hand with no sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccprism-status-empty-"));
    const code = await runStatusline(flags({ root }), { stdin: undefined });
    expect(code).toBe(2);
    expect(errorSpy).toHaveBeenCalled();
  });
});
