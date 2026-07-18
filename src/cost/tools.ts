import type {
  ExtractedSession,
  SessionEvent,
  ToolCallEvent,
} from "../parser/events.js";
import { costOfUsage } from "./cost.js";

// Buckets match the viewer's glyph families. chat is the bucket for
// api messages that invoked no tool at all.
export type ToolCategory =
  | "bash"
  | "edit"
  | "read"
  | "web"
  | "agents"
  | "mcp"
  | "other"
  | "chat";

const CATEGORY_BY_NAME: Record<string, ToolCategory> = {
  Bash: "bash",
  BashOutput: "bash",
  KillBash: "bash",
  KillShell: "bash",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Read: "read",
  Grep: "read",
  Glob: "read",
  LS: "read",
  NotebookRead: "read",
  WebFetch: "web",
  WebSearch: "web",
  Task: "agents",
  Agent: "agents",
};

export function toolCategory(toolName: string): ToolCategory {
  if (toolName.startsWith("mcp__")) return "mcp";
  return CATEGORY_BY_NAME[toolName] ?? "other";
}

export interface ToolCategoryStats {
  calls: number;
  failures: number;
  // Message cost attributed to this category. A message that made
  // several calls splits its cost evenly across them.
  usd: number;
}

export type ToolBreakdown = Map<ToolCategory, ToolCategoryStats>;

function statsFor(
  breakdown: ToolBreakdown,
  category: ToolCategory,
): ToolCategoryStats {
  let stats = breakdown.get(category);
  if (stats === undefined) {
    stats = { calls: 0, failures: 0, usd: 0 };
    breakdown.set(category, stats);
  }
  return stats;
}

function allEvents(session: ExtractedSession): SessionEvent[] {
  return [...session.events, ...session.sidechains.flat()];
}

// allowedMessageIds narrows to a time window. Undefined means no
// filter. Calls without a message id only count when unfiltered.
export function toolBreakdown(
  session: ExtractedSession,
  allowedMessageIds?: Set<string>,
): ToolBreakdown {
  const breakdown: ToolBreakdown = new Map();
  const events = allEvents(session);

  const failedResults = new Set<string>();
  for (const event of events) {
    if (event.kind === "tool-result" && event.isError && event.toolUseId !== undefined) {
      failedResults.add(event.toolUseId);
    }
  }

  const callsByMessage = new Map<string, ToolCallEvent[]>();
  for (const event of events) {
    if (event.kind !== "tool-call") continue;
    if (allowedMessageIds !== undefined) {
      if (event.messageId === undefined) continue;
      if (!allowedMessageIds.has(event.messageId)) continue;
    }
    const stats = statsFor(breakdown, toolCategory(event.toolName));
    stats.calls += 1;
    if (event.toolUseId !== undefined && failedResults.has(event.toolUseId)) {
      stats.failures += 1;
    }
    if (event.messageId !== undefined) {
      const calls = callsByMessage.get(event.messageId);
      if (calls === undefined) callsByMessage.set(event.messageId, [event]);
      else calls.push(event);
    }
  }

  for (const entry of session.usage) {
    if (allowedMessageIds !== undefined && !allowedMessageIds.has(entry.messageId)) {
      continue;
    }
    const usd = costOfUsage(entry.usage, entry.model);
    // Unknown models stay out of dollar figures everywhere.
    if (usd === undefined) continue;
    const calls = callsByMessage.get(entry.messageId);
    if (calls === undefined || calls.length === 0) {
      statsFor(breakdown, "chat").usd += usd;
      continue;
    }
    const share = usd / calls.length;
    for (const call of calls) {
      statsFor(breakdown, toolCategory(call.toolName)).usd += share;
    }
  }

  return breakdown;
}

export function mergeToolBreakdowns(into: ToolBreakdown, from: ToolBreakdown): void {
  for (const [category, stats] of from) {
    const target = statsFor(into, category);
    target.calls += stats.calls;
    target.failures += stats.failures;
    target.usd += stats.usd;
  }
}
