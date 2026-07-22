import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionSnapshot } from "../src/commands/compact.js";
import { runView, type ViewFlags } from "../src/commands/view.js";

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

// The compact log is view --follow --compact. Every case here runs it
// through view, which is the only way in now that watch is gone.
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
    compact: true,
    exportAs: undefined,
    out: undefined,
    ...extra,
  };
}

const CLOCK = () => new Date("2026-07-20T19:53:02");

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ccprism-compact-"));
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

describe("sessionSnapshot", () => {
  it("reflects file content and carries no timestamp", async () => {
    const snapshot = await sessionSnapshot(BASIC);
    const line = snapshot?.text;
    // Change detection compares this, so the clock must not be in it.
    expect(line).not.toMatch(/\d\d:\d\d:\d\d/);
    expect(line).toContain("opus-4-8");
    expect(line).toContain("ctx");
    expect(line).toContain("turns");
  });

  // The compared text must stay free of the delta, or an unchanged
  // session would print a "+$0.00" line on every tick forever.
  it("keeps the cost delta out of the compared text", async () => {
    const snapshot = await sessionSnapshot(BASIC);
    expect(snapshot?.text).not.toContain("+$");
    expect(typeof snapshot?.summary.total.usd).toBe("number");
  });

  it("yields a different line when the file's content changes", async () => {
    const before = await sessionSnapshot(COMPACT);
    const after = await sessionSnapshot(BASIC);
    expect(before?.text).not.toEqual(after?.text);
  });

  it("returns undefined for an unreadable file", async () => {
    expect(await sessionSnapshot("/no/such/file.jsonl")).toBeUndefined();
  });
});

describe("cost delta", () => {
  // Grows a session the way Claude Code does: a new assistant node
  // hung off the current leaf, and the trailing last-prompt line
  // rewritten to point at it. Without moving leafUuid the new node is
  // off the active branch and its cost would not count.
  const LEAF = "1c850ba5-2405-4e1c-9067-1a85b8468aa1";
  const NEXT = "aaaaaaaa-0000-0000-0000-000000000009";
  const SESSION = "13af1923-3b85-44dc-9715-0af802703bd6";

  async function growingRoot(): Promise<{ root: string; file: string }> {
    const root = await mkdtemp(join(tmpdir(), "ccprism-delta-"));
    const project = join(root, "-scrubbed-project");
    await mkdir(project);
    const file = join(project, `${SESSION}.jsonl`);
    await copyFile(BASIC, file);
    return { root, file };
  }

  async function grow(file: string): Promise<void> {
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    const kept = lines.filter((line) => !line.includes('"last-prompt"'));
    const turn = {
      parentUuid: LEAF,
      isSidechain: false,
      type: "assistant",
      uuid: NEXT,
      timestamp: "2026-07-20T19:53:10.000Z",
      sessionId: SESSION,
      message: {
        model: "claude-opus-4-8",
        id: "msg_delta_test",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "[scrubbed]" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 1000,
          output_tokens: 5000,
        },
      },
    };
    const trailer = { type: "last-prompt", leafUuid: NEXT, sessionId: SESSION };
    await writeFile(
      file,
      `${[...kept, JSON.stringify(turn), JSON.stringify(trailer)].join("\n")}\n`,
    );
  }

  async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("timed out waiting for condition");
  }

  it("prints the per-turn cost beside the total as the session grows", async () => {
    const { root, file } = await growingRoot();
    const controller = new AbortController();
    const run = runView(flags(root), {
      intervalMs: 15,
      signal: controller.signal,
      now: CLOCK,
    });

    await waitFor(() => logSpy.mock.calls.length >= 1);
    // The opening line has nothing to compare against, so no delta.
    expect(logged()).not.toContain("+$");

    await grow(file);
    await waitFor(() => logSpy.mock.calls.length >= 2);
    controller.abort();
    expect(await run).toBe(0);

    const lines = logged().split("\n");
    expect(lines[1]).toMatch(/\+\$\d+\.\d\d/);
    // The delta is the new turn only, while the total carries the
    // whole session, so the total has to be the larger of the two.
    const total = Number(/· \$(\d+\.\d\d) ·/.exec(lines[1] ?? "")?.[1]);
    const delta = Number(/\+\$(\d+\.\d\d)/.exec(lines[1] ?? "")?.[1]);
    expect(delta).toBeGreaterThan(0);
    expect(total).toBeGreaterThan(delta);
  });

  it("stays quiet when a touched file's numbers did not move", async () => {
    const { root, file } = await growingRoot();
    const controller = new AbortController();
    const run = runView(flags(root), {
      intervalMs: 15,
      signal: controller.signal,
      now: CLOCK,
    });
    await waitFor(() => logSpy.mock.calls.length >= 1);

    // Rewriting identical content moves mtime, so the poller wakes and
    // re-renders. A "+$0.00" line here would mean the delta leaked
    // into change detection.
    await writeFile(file, await readFile(file, "utf8"));
    await new Promise((r) => setTimeout(r, 90));
    controller.abort();
    await run;
    expect(logSpy.mock.calls.length).toBe(1);
  });
});

describe("compact follow (once)", () => {
  it("prints one line for the newest session and a header on stderr", async () => {
    const root = await makeRoot();
    const code = await runView(flags(root), { once: true, now: CLOCK });
    expect(code).toBe(0);
    expect(logged()).toMatch(/^\d\d:\d\d:\d\d {2}.*turns$/);
    expect(errored()).toContain("following");
    expect(errored()).toContain("ctrl-c");
  });

  // The static view is already the compact one, so --compact can only
  // mean the live log. Saying so beats silently starting a follower.
  it("refuses --compact without --follow", async () => {
    const root = await makeRoot();
    const code = await runView(flags(root, { follow: false }), { once: true });
    expect(code).toBe(2);
    expect(errored()).toContain("--compact is a mode of --follow");
    expect(logged()).toBe("");
  });

  it("resolves a session by id prefix", async () => {
    const root = await makeRoot();
    const code = await runView(flags(root, { id: "2222" }), {
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
    const code = await runView(flags(root, { id: "1111" }), { once: true });
    expect(code).toBe(1);
    expect(errored()).toContain("ambiguous");
  });

  it("exits 2 when nothing matches the id", async () => {
    const code = await runView(flags(await makeRoot(), { id: "9999" }), {
      once: true,
    });
    expect(code).toBe(2);
    expect(errored()).toContain("9999");
  });

  it("exits 2 on an empty root", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccprism-compact-empty-"));
    const code = await runView(flags(root), { once: true });
    expect(code).toBe(2);
    expect(errored()).toContain("no sessions found");
  });
});

describe("compact follow (streaming loop)", () => {
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
    const root = await mkdtemp(join(tmpdir(), "ccprism-compact-live-"));
    const project = join(root, "-scrubbed-project");
    await mkdir(project);
    const file = join(project, "11111111-aaaa-bbbb-cccc-000000000001.jsonl");
    await copyFile(COMPACT, file);

    const controller = new AbortController();
    const run = runView(flags(root), {
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
