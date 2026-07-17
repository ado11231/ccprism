import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { RawLine, ReadResult, ReadStats } from "./types.js";

// Types the rest of the parser handles.
const KNOWN_TYPES = new Set([
  "user",
  "assistant",
  "system",
  "attachment",
  "last-prompt",
]);

// Types seen in real logs that carry nothing the tool needs.
// Dropping them is safe because they hold no tree links or usage.
const IGNORED_TYPES = new Set([
  "agent-name",
  "ai-title",
  "file-history-delta",
  "file-history-snapshot",
  "mode",
  "permission-mode",
  "pr-link",
  "queue-operation",
  "summary",
]);

function emptyStats(): ReadStats {
  return {
    totalLines: 0,
    keptLines: 0,
    ignoredLines: 0,
    malformedLines: 0,
    unknownTypes: {},
  };
}

function toRawLine(line: Record<string, unknown>, type: string): RawLine {
  return {
    type,
    uuid: typeof line.uuid === "string" ? line.uuid : undefined,
    parentUuid: typeof line.parentUuid === "string" ? line.parentUuid : null,
    logicalParentUuid:
      typeof line.logicalParentUuid === "string"
        ? line.logicalParentUuid
        : undefined,
    isSidechain: line.isSidechain === true,
    timestamp: typeof line.timestamp === "string" ? line.timestamp : undefined,
    leafUuid: typeof line.leafUuid === "string" ? line.leafUuid : undefined,
    data: line,
  };
}

function classifyLine(text: string, out: RawLine[], stats: ReadStats): void {
  const trimmed = text.trim();
  if (trimmed === "") return;
  stats.totalLines += 1;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    stats.malformedLines += 1;
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    stats.malformedLines += 1;
    return;
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.type !== "string") {
    stats.malformedLines += 1;
    return;
  }

  const line = toRawLine(record, record.type);
  if (!KNOWN_TYPES.has(line.type) && !IGNORED_TYPES.has(line.type)) {
    stats.unknownTypes[line.type] = (stats.unknownTypes[line.type] ?? 0) + 1;
  }

  // Any line with a uuid stays, even with an unknown type, because
  // parent chains pass through system and attachment lines and could
  // pass through types this version has never seen. Last prompt lines
  // stay because they carry the leafUuid that marks the active branch.
  if (line.uuid !== undefined || line.type === "last-prompt") {
    out.push(line);
    stats.keptLines += 1;
    return;
  }

  stats.ignoredLines += 1;
}

export async function classifyLines(
  input: Iterable<string> | AsyncIterable<string>,
): Promise<ReadResult> {
  const lines: RawLine[] = [];
  const stats = emptyStats();
  for await (const text of input) {
    classifyLine(text, lines, stats);
  }
  return { lines, stats };
}

export async function readSessionFile(path: string): Promise<ReadResult> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    return await classifyLines(reader);
  } finally {
    reader.close();
    stream.close();
  }
}
