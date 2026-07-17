import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";

describe("cli scaffold", () => {
  it("registers the v1 commands", () => {
    const program = buildProgram();
    const names = program.commands.map((command) => command.name());
    expect(names).toEqual(["sessions", "view", "doctor"]);
  });

  it("is named ccprism", () => {
    expect(buildProgram().name()).toBe("ccprism");
  });
});
