import type { ResolvedTree } from "./tree.js";
import type { RawLine } from "./types.js";

// Token counts for one API message. Cache writes carry an optional
// split by lifetime because newer logs price 5 minute and 1 hour
// cache entries differently.
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreationTotal: number;
  cacheCreation5m: number | undefined;
  cacheCreation1h: number | undefined;
}

// One entry per API message, deduped by message id. A response is
// written as several assistant lines that all repeat the same usage,
// so summing per line would multiply real cost.
export interface MessageUsage {
  messageId: string;
  model: string;
  usage: Usage;
  isSidechain: boolean;
  // False for api calls on abandoned branches, for example retries.
  // They cost money, so they are recorded, but the transcript never
  // shows them and metrics can call them out separately.
  onActiveBranch: boolean;
  timestamp: string | undefined;
}

export interface UserEvent {
  kind: "user";
  text: string;
  isMeta: boolean;
  timestamp: string | undefined;
}

export interface AssistantTextEvent {
  kind: "assistant-text";
  text: string;
  model: string | undefined;
  messageId: string | undefined;
  timestamp: string | undefined;
}

export interface ThinkingEvent {
  kind: "thinking";
  text: string;
  messageId: string | undefined;
  timestamp: string | undefined;
}

export interface ToolCallEvent {
  kind: "tool-call";
  toolName: string;
  toolUseId: string | undefined;
  // Bash calls carry a short model written description of the command.
  description: string | undefined;
  input: unknown;
  messageId: string | undefined;
  timestamp: string | undefined;
}

export interface ToolResultEvent {
  kind: "tool-result";
  toolUseId: string | undefined;
  text: string;
  isError: boolean;
  timestamp: string | undefined;
}

export type SessionEvent =
  | UserEvent
  | AssistantTextEvent
  | ThinkingEvent
  | ToolCallEvent
  | ToolResultEvent;

export interface SessionMeta {
  sessionId: string | undefined;
  version: string | undefined;
  cwd: string | undefined;
  gitBranch: string | undefined;
  firstTimestamp: string | undefined;
  lastTimestamp: string | undefined;
  // Distinct real models seen, synthetic placeholder excluded.
  models: string[];
}

export interface ExtractStats {
  unknownBlocks: number;
}

export interface ExtractedSession {
  meta: SessionMeta;
  events: SessionEvent[];
  sidechains: SessionEvent[][];
  usage: MessageUsage[];
  stats: ExtractStats;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readUsage(value: unknown): Usage | undefined {
  const usage = asRecord(value);
  if (usage === undefined) return undefined;
  const split = asRecord(usage.cache_creation);
  return {
    input: asNumber(usage.input_tokens),
    output: asNumber(usage.output_tokens),
    cacheRead: asNumber(usage.cache_read_input_tokens),
    cacheCreationTotal: asNumber(usage.cache_creation_input_tokens),
    cacheCreation5m:
      split === undefined
        ? undefined
        : asNumber(split.ephemeral_5m_input_tokens),
    cacheCreation1h:
      split === undefined
        ? undefined
        : asNumber(split.ephemeral_1h_input_tokens),
  };
}

// Tool result content is either a plain string or a list of blocks.
// Non text blocks become placeholders instead of disappearing.
function readResultText(content: unknown): string {
  const text = asString(content);
  if (text !== undefined) return text;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    const block = asRecord(item);
    if (block === undefined) continue;
    const blockText = asString(block.text);
    if (blockText !== undefined) {
      parts.push(blockText);
    } else {
      parts.push(`[${asString(block.type) ?? "unknown"}]`);
    }
  }
  return parts.join("\n");
}

function extractUserLine(line: RawLine, events: SessionEvent[]): void {
  const message = asRecord(line.data.message);
  if (message === undefined) return;
  const isMeta = line.data.isMeta === true;

  const text = asString(message.content);
  if (text !== undefined) {
    events.push({ kind: "user", text, isMeta, timestamp: line.timestamp });
    return;
  }

  if (!Array.isArray(message.content)) return;
  for (const item of message.content) {
    const block = asRecord(item);
    if (block === undefined) continue;
    if (block.type === "text") {
      events.push({
        kind: "user",
        text: asString(block.text) ?? "",
        isMeta,
        timestamp: line.timestamp,
      });
    } else if (block.type === "tool_result") {
      events.push({
        kind: "tool-result",
        toolUseId: asString(block.tool_use_id),
        text: readResultText(block.content),
        isError: block.is_error === true,
        timestamp: line.timestamp,
      });
    }
  }
}

function recordUsage(
  line: RawLine,
  ledger: Map<string, MessageUsage>,
  onActiveBranch: boolean,
): void {
  const message = asRecord(line.data.message);
  if (message === undefined) return;
  const messageId = asString(message.id);
  const model = asString(message.model);
  if (messageId === undefined || model === undefined) return;
  const usage = readUsage(message.usage);
  if (usage === undefined || ledger.has(messageId)) return;
  ledger.set(messageId, {
    messageId,
    model,
    usage,
    isSidechain: line.isSidechain,
    onActiveBranch,
    timestamp: line.timestamp,
  });
}

function extractAssistantLine(
  line: RawLine,
  events: SessionEvent[],
  ledger: Map<string, MessageUsage>,
  stats: ExtractStats,
): void {
  const message = asRecord(line.data.message);
  if (message === undefined) return;
  const messageId = asString(message.id);
  const model = asString(message.model);
  recordUsage(line, ledger, true);

  if (!Array.isArray(message.content)) return;
  for (const item of message.content) {
    const block = asRecord(item);
    if (block === undefined) continue;
    if (block.type === "text") {
      events.push({
        kind: "assistant-text",
        text: asString(block.text) ?? "",
        model,
        messageId,
        timestamp: line.timestamp,
      });
    } else if (block.type === "thinking") {
      events.push({
        kind: "thinking",
        text: asString(block.thinking) ?? "",
        messageId,
        timestamp: line.timestamp,
      });
    } else if (block.type === "tool_use") {
      const input = block.input;
      events.push({
        kind: "tool-call",
        toolName: asString(block.name) ?? "unknown",
        toolUseId: asString(block.id),
        description: asString(asRecord(input)?.description),
        input,
        messageId,
        timestamp: line.timestamp,
      });
    } else {
      stats.unknownBlocks += 1;
    }
  }
}

function extractEvents(
  lines: RawLine[],
  ledger: Map<string, MessageUsage>,
  stats: ExtractStats,
): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const line of lines) {
    if (line.type === "user") {
      extractUserLine(line, events);
    } else if (line.type === "assistant") {
      extractAssistantLine(line, events, ledger, stats);
    }
    // Other types carry no conversation content.
  }
  return events;
}

function extractMeta(
  branch: RawLine[],
  ledger: Map<string, MessageUsage>,
): SessionMeta {
  const meta: SessionMeta = {
    sessionId: undefined,
    version: undefined,
    cwd: undefined,
    gitBranch: undefined,
    firstTimestamp: undefined,
    lastTimestamp: undefined,
    models: [],
  };
  for (const line of branch) {
    meta.sessionId ??= asString(line.data.sessionId);
    meta.version ??= asString(line.data.version);
    meta.cwd ??= asString(line.data.cwd);
    meta.gitBranch ??= asString(line.data.gitBranch);
    if (line.timestamp !== undefined) {
      meta.firstTimestamp ??= line.timestamp;
      meta.lastTimestamp = line.timestamp;
    }
  }
  const models = new Set<string>();
  for (const entry of ledger.values()) {
    if (entry.model !== "<synthetic>") models.add(entry.model);
  }
  meta.models = [...models];
  return meta;
}

export function extractSession(tree: ResolvedTree): ExtractedSession {
  const ledger = new Map<string, MessageUsage>();
  const stats: ExtractStats = { unknownBlocks: 0 };
  const events = extractEvents(tree.branch, ledger, stats);
  const sidechains = tree.sidechains.map((group) =>
    extractEvents(group, ledger, stats),
  );
  // Abandoned branches produced real api calls. Their usage counts,
  // their events do not.
  for (const line of tree.inactive) {
    if (line.type === "assistant") recordUsage(line, ledger, false);
  }
  return {
    meta: extractMeta(tree.branch, ledger),
    events,
    sidechains,
    usage: [...ledger.values()],
    stats,
  };
}
