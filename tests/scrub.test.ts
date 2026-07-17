import { describe, expect, it } from "vitest";
import { scrubLine, scrubValue } from "../scripts/scrub.mjs";

describe("scrubValue", () => {
  it("replaces content strings and keeps structural strings", () => {
    const scrubbed = scrubValue({
      type: "assistant",
      uuid: "abc-123",
      message: {
        id: "msg_1",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "private conversation text" }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }) as Record<string, unknown>;

    expect(scrubbed.type).toBe("assistant");
    expect(scrubbed.uuid).toBe("abc-123");
    const message = scrubbed.message as Record<string, unknown>;
    expect(message.model).toBe("claude-opus-4-8");
    const blocks = message.content as Record<string, unknown>[];
    expect(blocks[0]?.type).toBe("text");
    expect(blocks[0]?.text).toBe("[scrubbed]");
    expect(message.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
  });

  it("scrubs path like object keys", () => {
    const scrubbed = scrubValue({
      readFileState: {
        "/Users/someone/project/secret.ts": { mtime: 5 },
        "/Users/someone/project/other.ts": { mtime: 9 },
      },
    }) as Record<string, Record<string, unknown>>;

    const keys = Object.keys(scrubbed.readFileState ?? {});
    expect(keys).toEqual(["[scrubbed-key-1]", "[scrubbed-key-2]"]);
  });

  it("scrubs tool input values but keeps the tool name", () => {
    const scrubbed = scrubValue({
      type: "tool_use",
      id: "toolu_1",
      name: "Bash",
      input: { command: "rm -rf /secret", description: "Delete things" },
    }) as Record<string, unknown>;

    expect(scrubbed.name).toBe("Bash");
    expect(scrubbed.input).toEqual({
      command: "[scrubbed]",
      description: "[scrubbed]",
    });
  });
});

describe("scrubLine", () => {
  it("replaces malformed lines with a malformed placeholder", () => {
    const result = scrubLine("{ secret content that never parsed");
    expect(result).not.toContain("secret");
    expect(() => JSON.parse(result)).toThrow();
  });

  it("passes blank lines through", () => {
    expect(scrubLine("")).toBe("");
  });
});
