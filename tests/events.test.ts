import { describe, expect, it } from "vitest";
import { extractSession } from "../src/parser/events.js";
import { resolveTree } from "../src/parser/tree.js";
import type { RawLine } from "../src/parser/types.js";

const USAGE = {
  input_tokens: 100,
  output_tokens: 50,
  cache_read_input_tokens: 2000,
  cache_creation_input_tokens: 300,
  cache_creation: {
    ephemeral_5m_input_tokens: 100,
    ephemeral_1h_input_tokens: 200,
  },
};

interface LineSpec {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  leafUuid?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
}

function raw(spec: LineSpec): RawLine {
  return {
    type: spec.type,
    uuid: spec.uuid,
    parentUuid: spec.parentUuid ?? null,
    logicalParentUuid: undefined,
    isSidechain: spec.isSidechain ?? false,
    timestamp: spec.timestamp,
    leafUuid: spec.leafUuid,
    data: spec.data ?? {},
  };
}

function userLine(uuid: string, parent: string | null, content: unknown): RawLine {
  return raw({
    type: "user",
    uuid,
    parentUuid: parent,
    data: { message: { role: "user", content } },
  });
}

function assistantLine(
  uuid: string,
  parent: string,
  block: unknown,
  messageId = "msg_1",
): RawLine {
  return raw({
    type: "assistant",
    uuid,
    parentUuid: parent,
    data: {
      message: {
        id: messageId,
        model: "claude-opus-4-8",
        role: "assistant",
        content: [block],
        usage: USAGE,
      },
    },
  });
}

function lastPrompt(leafUuid: string): RawLine {
  return raw({ type: "last-prompt", leafUuid });
}

function extract(lines: RawLine[]) {
  return extractSession(resolveTree(lines));
}

describe("extractSession events", () => {
  it("extracts a plain user message", () => {
    const result = extract([userLine("u1", null, "hello"), lastPrompt("u1")]);
    expect(result.events).toEqual([
      { kind: "user", text: "hello", isMeta: false, timestamp: undefined },
    ]);
  });

  it("extracts assistant text, thinking, and tool call blocks in order", () => {
    const result = extract([
      userLine("u1", null, "hi"),
      assistantLine("a1", "u1", { type: "thinking", thinking: "hmm" }),
      assistantLine("a2", "a1", { type: "text", text: "hello back" }),
      assistantLine("a3", "a2", {
        type: "tool_use",
        id: "toolu_1",
        name: "Bash",
        input: { command: "ls", description: "List files" },
      }),
      lastPrompt("a3"),
    ]);
    expect(result.events.map((e) => e.kind)).toEqual([
      "user",
      "thinking",
      "assistant-text",
      "tool-call",
    ]);
    const call = result.events[3];
    expect(call).toMatchObject({
      toolName: "Bash",
      toolUseId: "toolu_1",
      description: "List files",
    });
  });

  it("turns tool_result blocks inside user lines into tool result events", () => {
    const result = extract([
      userLine("u1", null, [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "file.txt",
          is_error: false,
        },
      ]),
      lastPrompt("u1"),
    ]);
    expect(result.events).toEqual([
      {
        kind: "tool-result",
        toolUseId: "toolu_1",
        text: "file.txt",
        isError: false,
        timestamp: undefined,
      },
    ]);
  });

  it("flattens array tool result content and keeps placeholders for non text blocks", () => {
    const result = extract([
      userLine("u1", null, [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [
            { type: "text", text: "line one" },
            { type: "image", source: {} },
          ],
          is_error: true,
        },
      ]),
      lastPrompt("u1"),
    ]);
    expect(result.events[0]).toMatchObject({
      text: "line one\n[image]",
      isError: true,
    });
  });

  it("marks meta user messages", () => {
    const result = extract([
      raw({
        type: "user",
        uuid: "u1",
        data: { isMeta: true, message: { role: "user", content: "injected" } },
      }),
      lastPrompt("u1"),
    ]);
    expect(result.events[0]).toMatchObject({ kind: "user", isMeta: true });
  });

  it("counts unknown content blocks", () => {
    const result = extract([
      userLine("u1", null, "hi"),
      assistantLine("a1", "u1", { type: "server_tool_use", id: "x" }),
      lastPrompt("a1"),
    ]);
    expect(result.stats.unknownBlocks).toBe(1);
  });
});

describe("extractSession usage ledger", () => {
  it("dedupes usage across lines that share a message id", () => {
    const result = extract([
      userLine("u1", null, "hi"),
      assistantLine("a1", "u1", { type: "text", text: "part one" }, "msg_1"),
      assistantLine("a2", "a1", { type: "text", text: "part two" }, "msg_1"),
      lastPrompt("a2"),
    ]);
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]).toMatchObject({
      messageId: "msg_1",
      model: "claude-opus-4-8",
      onActiveBranch: true,
      usage: {
        input: 100,
        output: 50,
        cacheRead: 2000,
        cacheCreationTotal: 300,
        cacheCreation5m: 100,
        cacheCreation1h: 200,
      },
    });
  });

  it("records usage from abandoned retries as off branch", () => {
    const result = extract([
      userLine("u1", null, "hi"),
      assistantLine("old", "u1", { type: "text", text: "abandoned" }, "msg_old"),
      assistantLine("new", "u1", { type: "text", text: "kept" }, "msg_new"),
      lastPrompt("new"),
    ]);
    expect(result.events.map((e) => e.kind)).toEqual(["user", "assistant-text"]);
    const byId = new Map(result.usage.map((u) => [u.messageId, u]));
    expect(byId.get("msg_new")?.onActiveBranch).toBe(true);
    expect(byId.get("msg_old")?.onActiveBranch).toBe(false);
  });

  it("handles usage without the cache creation split", () => {
    const line = raw({
      type: "assistant",
      uuid: "a1",
      data: {
        message: {
          id: "msg_1",
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    });
    const result = extract([line, lastPrompt("a1")]);
    expect(result.usage[0]?.usage).toMatchObject({
      input: 10,
      cacheCreation5m: undefined,
      cacheCreation1h: undefined,
    });
  });

  it("extracts sidechain events separately and flags their usage", () => {
    const side = raw({
      type: "assistant",
      uuid: "s1",
      isSidechain: true,
      data: {
        message: {
          id: "msg_side",
          model: "claude-haiku-4-5-20251001",
          content: [{ type: "text", text: "subagent reply" }],
          usage: USAGE,
        },
      },
    });
    const result = extract([userLine("u1", null, "hi"), side, lastPrompt("u1")]);
    expect(result.events.map((e) => e.kind)).toEqual(["user"]);
    expect(result.sidechains).toHaveLength(1);
    expect(result.sidechains[0]?.[0]).toMatchObject({ kind: "assistant-text" });
    const entry = result.usage.find((u) => u.messageId === "msg_side");
    expect(entry?.isSidechain).toBe(true);
  });
});

describe("extractSession meta", () => {
  it("collects session header fields and model list", () => {
    const first = raw({
      type: "user",
      uuid: "u1",
      timestamp: "2026-07-17T10:00:00Z",
      data: {
        sessionId: "abc",
        version: "2.1.0",
        cwd: "/home/user/project",
        gitBranch: "main",
        message: { role: "user", content: "hi" },
      },
    });
    const result = extract([
      first,
      assistantLine("a1", "u1", { type: "text", text: "hello" }),
      lastPrompt("a1"),
    ]);
    expect(result.meta).toMatchObject({
      sessionId: "abc",
      version: "2.1.0",
      cwd: "/home/user/project",
      gitBranch: "main",
      firstTimestamp: "2026-07-17T10:00:00Z",
      models: ["claude-opus-4-8"],
    });
  });

  it("excludes the synthetic placeholder model from the model list", () => {
    const synthetic = raw({
      type: "assistant",
      uuid: "a1",
      data: {
        message: {
          id: "msg_syn",
          model: "<synthetic>",
          content: [{ type: "text", text: "api error" }],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    });
    const result = extract([synthetic, lastPrompt("a1")]);
    expect(result.meta.models).toEqual([]);
    expect(result.usage).toHaveLength(1);
  });
});
