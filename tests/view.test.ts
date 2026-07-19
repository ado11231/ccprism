import { copyFile, mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runView, type ViewFlags } from "../src/commands/view.js";

const FIXTURES = join(__dirname, "fixtures");

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

function errored(): string {
  return errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
}

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
    ...extra,
  };
}

// basic.jsonl is the newer session, compact.jsonl the older one.
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ccprism-view-"));
  const project = join(root, "-scrubbed-project");
  await mkdir(project);
  const older = join(project, "22222222-aaaa-bbbb-cccc-000000000002.jsonl");
  const newer = join(project, "11111111-aaaa-bbbb-cccc-000000000001.jsonl");
  await copyFile(join(FIXTURES, "compact.jsonl"), older);
  await copyFile(join(FIXTURES, "basic.jsonl"), newer);
  const now = Date.now() / 1000;
  await utimes(older, now - 100, now - 100);
  await utimes(newer, now, now);
  return root;
}

describe("view", () => {
  it("renders the latest session by default", async () => {
    const root = await makeRoot();
    const code = await runView(flags(root));
    expect(code).toBe(0);
    expect(logged()).toContain("session 13af1923");
    expect(logged()).toContain("● YOU");
  });

  it("skips stub files without conversation when picking the latest", async () => {
    const root = await makeRoot();
    const stub = join(root, "-scrubbed-project", "33333333-aaaa-bbbb-cccc-000000000003.jsonl");
    await writeFile(stub, `${JSON.stringify({ type: "agent-name", name: "x" })}\n`);
    const future = Date.now() / 1000 + 100;
    await utimes(stub, future, future);
    const code = await runView(flags(root));
    expect(code).toBe(0);
    expect(logged()).toContain("session 13af1923");
  });

  it("resolves an id prefix", async () => {
    const root = await makeRoot();
    const code = await runView(flags(root, { id: "2222" }));
    expect(code).toBe(0);
    expect(logged()).toContain("session 8f132d72");
  });

  it("rejects an ambiguous prefix and lists the matches", async () => {
    const root = await makeRoot();
    const extra = join(root, "-scrubbed-project", "11111111-ffff-bbbb-cccc-000000000009.jsonl");
    await copyFile(join(FIXTURES, "basic.jsonl"), extra);
    const code = await runView(flags(root, { id: "1111" }));
    expect(code).toBe(1);
    expect(errored()).toContain("ambiguous");
    expect(errored()).toContain("11111111-ffff");
  });

  it("exits 2 when nothing matches the id", async () => {
    const code = await runView(flags(await makeRoot(), { id: "9999" }));
    expect(code).toBe(2);
    expect(errored()).toContain("9999");
  });

  it("exits 2 on an empty root", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccprism-view-empty-"));
    const code = await runView(flags(root));
    expect(code).toBe(2);
  });

  it("emits the assembled transcript as json", async () => {
    const root = await makeRoot();
    const code = await runView(flags(root, { json: true, id: "1111" }));
    expect(code).toBe(0);
    const out = JSON.parse(logged());
    expect(out.summary.turns).toBeGreaterThan(0);
    expect(Array.isArray(out.turns)).toBe(true);
    expect(out.turns[0].items).toBeDefined();
    expect(out.stats.orphanResults).toBe(0);
  });

  it("swaps glyphs with --ascii", async () => {
    const root = await makeRoot();
    const code = await runView(flags(root, { id: "1111", ascii: true }));
    expect(code).toBe(0);
    expect(logged()).toContain("* YOU");
    expect(logged()).not.toContain("●");
  });

  it("shows more with --full than without", async () => {
    const root = await makeRoot();
    await runView(flags(root, { id: "2222" }));
    const compact = logged().split("\n").length;
    logSpy.mockClear();
    await runView(flags(root, { id: "2222", full: true }));
    const full = logged().split("\n").length;
    expect(full).toBeGreaterThan(compact);
  });
});
