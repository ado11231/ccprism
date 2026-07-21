import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/cli.js";

describe("cli scaffold", () => {
  it("registers the v1 commands", () => {
    const program = buildProgram();
    const names = program.commands.map((command) => command.name());
    expect(names).toEqual([
      "statusline",
      "watch",
      "sessions",
      "view",
      "doctor",
    ]);
  });

  // Commands are grouped in --help by what they are for, and commander
  // orders the groups by first registration. That makes declaration
  // order load bearing, so both the grouping and the fact that live
  // commands come first are pinned here.
  it("groups the commands, live ones first", () => {
    const groups = buildProgram().commands.map((command) => [
      command.name(),
      command.helpGroup(),
    ]);
    expect(groups).toEqual([
      ["statusline", "Live:"],
      ["watch", "Live:"],
      ["sessions", "Reports:"],
      ["view", "Reports:"],
      ["doctor", "Reports:"],
    ]);
  });

  // The dashboard and view --follow are features without a command of
  // their own, so the grouped list cannot mention them.
  it("documents the two features that are not commands", () => {
    // Via outputHelp, not helpInformation: the trailing text is added
    // by an addHelpText hook, which only the former runs.
    const program = buildProgram();
    let help = "";
    program.configureOutput({
      writeOut: (chunk) => {
        help += chunk;
      },
    });
    program.outputHelp();
    expect(help).toContain("Live:");
    expect(help).toContain("Reports:");
    expect(help).toContain("Run with no command for the dashboard");
    expect(help).toContain("view --follow");
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
