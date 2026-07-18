import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDashboard } from "../src/commands/dashboard.js";
import { runDoctor } from "../src/commands/doctor.js";
import { runSessions } from "../src/commands/sessions.js";
import type { CommandFlags } from "../src/commands/load.js";

const FIXTURES = join(__dirname, "fixtures");

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function logged(): string {
  return logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
}

function flags(root: string, extra: Partial<CommandFlags> = {}): CommandFlags {
  return {
    json: true,
    color: false,
    project: undefined,
    since: undefined,
    until: undefined,
    root,
    ...extra,
  };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ccprism-commands-"));
  const projectA = join(root, "-scrubbed-projectA");
  const projectB = join(root, "-scrubbed-projectB");
  await mkdir(projectA);
  await mkdir(projectB);
  await copyFile(
    join(FIXTURES, "basic.jsonl"),
    join(projectA, "11111111-aaaa-bbbb-cccc-000000000001.jsonl"),
  );
  await copyFile(
    join(FIXTURES, "compact.jsonl"),
    join(projectB, "22222222-aaaa-bbbb-cccc-000000000002.jsonl"),
  );
  return root;
}

describe("dashboard", () => {
  it("aggregates both fixture sessions as json", async () => {
    const code = await runDashboard(flags(await makeRoot()));
    expect(code).toBe(0);
    const out = JSON.parse(logged());
    expect(out.sessions).toBe(2);
    expect(out.total.messages).toBe(107);
    expect(out.total.usd).toBeGreaterThan(0);
    expect(out.total.unknownModels).toEqual([]);
    expect(out.byModel).toHaveLength(1);
    expect(out.byModel[0].model).toBe("claude-opus-4-8");
    expect(out.byProject).toHaveLength(2);
    expect(out.cacheHitRatio).toBeGreaterThan(0);
    // The compact fixture has tool calls, so byTool must carry cost
    // in tool buckets and a chat bucket for text only messages.
    const categories = out.byTool.map((t: { category: string }) => t.category);
    expect(categories).toContain("chat");
    expect(out.byTool.length).toBeGreaterThan(1);
    const toolUsd = out.byTool.reduce(
      (sum: number, t: { usd: number }) => sum + t.usd,
      0,
    );
    expect(toolUsd).toBeCloseTo(out.total.usd, 6);
    expect(out.subagents.messages).toBeGreaterThanOrEqual(0);
    expect(out.retries.messages).toBeGreaterThanOrEqual(0);
  });

  it("exits 2 when there are no sessions", async () => {
    const empty = await mkdtemp(join(tmpdir(), "ccprism-empty-"));
    expect(await runDashboard(flags(empty))).toBe(2);
  });

  it("exits 1 on an invalid date", async () => {
    const code = await runDashboard(
      flags(await makeRoot(), { since: "not-a-date" }),
    );
    expect(code).toBe(1);
  });

  it("filters usage with a window", async () => {
    // A window in the far past matches no usage.
    const code = await runDashboard(
      flags(await makeRoot(), { since: "2000-01-01", until: "2000-01-02" }),
    );
    expect(code).toBe(0);
    const out = JSON.parse(logged());
    expect(out.sessions).toBe(0);
    expect(out.total.messages).toBe(0);
  });

  it("renders text output without a json flag", async () => {
    const code = await runDashboard(flags(await makeRoot(), { json: false }));
    expect(code).toBe(0);
    const text = logged();
    expect(text).toContain("ccprism");
    expect(text).toContain("today");
    expect(text).toContain("model");
    expect(text).not.toContain("[");
  });
});

describe("sessions", () => {
  it("lists sessions newest first as json", async () => {
    const code = await runSessions({ ...flags(await makeRoot()), limit: 20 });
    expect(code).toBe(0);
    const rows = JSON.parse(logged());
    expect(rows).toHaveLength(2);
    const stamps = rows.map((r: { lastTimestamp: string }) => r.lastTimestamp);
    expect([...stamps].sort().reverse()).toEqual(stamps);
    expect(rows[0].rollup.usd).toBeGreaterThan(0);
  });

  it("honors the limit", async () => {
    const code = await runSessions({ ...flags(await makeRoot()), limit: 1 });
    expect(code).toBe(0);
    expect(JSON.parse(logged())).toHaveLength(1);
  });
});

describe("doctor", () => {
  it("reports clean fixtures as json", async () => {
    const code = await runDoctor(flags(await makeRoot()));
    expect(code).toBe(0);
    const out = JSON.parse(logged());
    expect(out.sessions).toBe(2);
    expect(out.malformedLines).toBe(0);
    expect(out.unknownLineTypes).toEqual({});
    expect(out.modelsWithoutPricing).toEqual([]);
    expect(out.flaggedSessions).toEqual([]);
  });

  it("exits 2 when there are no sessions", async () => {
    const empty = await mkdtemp(join(tmpdir(), "ccprism-empty-"));
    expect(await runDoctor(flags(empty))).toBe(2);
  });

  it("does not flag stub sessions holding only metadata lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccprism-stub-"));
    const project = join(root, "-scrubbed-stub");
    await mkdir(project);
    await writeFile(
      join(project, "33333333-aaaa-bbbb-cccc-000000000003.jsonl"),
      '{"type":"agent-name","agentName":"x"}\n{"type":"ai-title","title":"y"}\n',
    );
    const code = await runDoctor(flags(root));
    expect(code).toBe(0);
    expect(JSON.parse(logged()).flaggedSessions).toEqual([]);
  });
});
