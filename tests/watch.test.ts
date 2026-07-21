import { copyFile, mkdir, mkdtemp, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchFlags } from "../src/commands/watch.js";
import { runWatch, sessionLine } from "../src/commands/watch.js";

const FIXTURES = join(__dirname, "fixtures");
const BASIC = join(FIXTURES, "basic.jsonl");
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

function logged(): string {
  return logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
}

function errored(): string {
  return errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
}

function flags(root: string, extra: Partial<WatchFlags> = {}): WatchFlags {
  return {
    json: false,
    color: false,
    project: undefined,
    since: undefined,
    until: undefined,
    root,
    id: undefined,
    ...extra,
  };
}

const CLOCK = () => new Date("2026-07-20T19:53:02");

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ccprism-watch-"));
  const project = join(root, "-scrubbed-project");
  await mkdir(project);
  const older = join(project, "22222222-aaaa-bbbb-cccc-000000000002.jsonl");
  const newer = join(project, "11111111-aaaa-bbbb-cccc-000000000001.jsonl");
  await copyFile(COMPACT, older);
  await copyFile(BASIC, newer);
  const now = Date.now() / 1000;
  await utimes(older, now - 100, now - 100);
  await utimes(newer, now, now);
  return root;
}

describe("sessionLine", () => {
  it("reflects file content and carries no timestamp", async () => {
    const line = await sessionLine(BASIC);
    // Change detection compares this, so the clock must not be in it.
    expect(line).not.toMatch(/\d\d:\d\d:\d\d/);
    expect(line).toContain("opus-4-8");
    expect(line).toContain("ctx");
    expect(line).toContain("turns");
  });

  it("yields a different line when the file's content changes", async () => {
    const before = await sessionLine(COMPACT);
    const after = await sessionLine(BASIC);
    expect(before).not.toEqual(after);
  });

  it("returns undefined for an unreadable file", async () => {
    expect(await sessionLine("/no/such/file.jsonl")).toBeUndefined();
  });
});

describe("runWatch (once)", () => {
  it("prints one line for the newest session and a header on stderr", async () => {
    const root = await makeRoot();
    const code = await runWatch(flags(root), { once: true, now: CLOCK });
    expect(code).toBe(0);
    expect(logged()).toMatch(/^\d\d:\d\d:\d\d {2}.*turns$/);
    expect(errored()).toContain("watching");
    expect(errored()).toContain("ctrl-c");
  });

  it("resolves a session by id prefix", async () => {
    const root = await makeRoot();
    const code = await runWatch(flags(root, { id: "2222" }), {
      once: true,
      now: CLOCK,
    });
    expect(code).toBe(0);
    expect(logged()).toContain("turns");
  });

  it("rejects an ambiguous prefix and exits 1", async () => {
    const root = await makeRoot();
    const extra = join(
      root,
      "-scrubbed-project",
      "11111111-ffff-bbbb-cccc-000000000009.jsonl",
    );
    await copyFile(BASIC, extra);
    const code = await runWatch(flags(root, { id: "1111" }), { once: true });
    expect(code).toBe(1);
    expect(errored()).toContain("ambiguous");
  });

  it("exits 2 when nothing matches the id", async () => {
    const code = await runWatch(flags(await makeRoot(), { id: "9999" }), {
      once: true,
    });
    expect(code).toBe(2);
    expect(errored()).toContain("9999");
  });

  it("exits 2 on an empty root", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccprism-watch-empty-"));
    const code = await runWatch(flags(root), { once: true });
    expect(code).toBe(2);
    expect(errored()).toContain("no sessions found");
  });
});

describe("runWatch (streaming loop)", () => {
  async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("timed out waiting for condition");
  }

  function distinctLines(): number {
    return new Set(logSpy.mock.calls.map((call) => call.join(" "))).size;
  }

  it("appends a new line when the watched file changes, then stops on signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccprism-watch-live-"));
    const project = join(root, "-scrubbed-project");
    await mkdir(project);
    const file = join(project, "11111111-aaaa-bbbb-cccc-000000000001.jsonl");
    await copyFile(COMPACT, file);

    const controller = new AbortController();
    const run = runWatch(flags(root), {
      intervalMs: 15,
      now: CLOCK,
      signal: controller.signal,
    });

    // First line lands before the loop starts.
    await waitFor(() => distinctLines() >= 1);

    // Grow/replace the file with different content; the poll picks it
    // up and prints a second, different line.
    await copyFile(BASIC, file);
    const now = Date.now() / 1000;
    await utimes(file, now, now);
    await waitFor(() => distinctLines() >= 2);
    const afterChange = logSpy.mock.calls.length;

    // Touch the file again with identical content: the poll fires but
    // the cost line is unchanged, so nothing new is printed.
    const later = now + 5;
    await utimes(file, later, later);
    await new Promise((r) => setTimeout(r, 60));

    controller.abort();
    const code = await run;
    expect(code).toBe(0);
    expect(distinctLines()).toBe(2);
    expect(logSpy.mock.calls.length).toBe(afterChange);
  });
});
