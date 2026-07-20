import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/cli.js";

describe("cli scaffold", () => {
  it("registers the v1 commands", () => {
    const program = buildProgram();
    const names = program.commands.map((command) => command.name());
    expect(names).toEqual(["sessions", "view", "statusline", "doctor"]);
  });

  it("is named ccprism", () => {
    expect(buildProgram().name()).toBe("ccprism");
  });
});

describe("option routing", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Flags like --json exist on the root for the dashboard and on
  // every subcommand. Commander can route them to either scope, so
  // actions must read optsWithGlobals. This locks that in.
  it("delivers shared flags to subcommand actions", async () => {
    const program = buildProgram();
    const sessions = program.commands.find((c) => c.name() === "sessions");
    expect(sessions).toBeDefined();
    let seen: Record<string, unknown> | undefined;
    sessions!.action((_opts: unknown, command: { optsWithGlobals(): Record<string, unknown> }) => {
      seen = command.optsWithGlobals();
    });
    await program.parseAsync([
      "node", "ccprism", "sessions", "--json", "--limit", "3", "--since", "2026-01-01",
    ]);
    expect(seen).toMatchObject({ json: true, limit: "3", since: "2026-01-01" });
  });
});
