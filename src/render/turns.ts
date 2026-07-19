import { costOfUsage } from "../cost/cost.js";
import type {
  AssistantTextEvent,
  ExtractedSession,
  SessionEvent,
  ThinkingEvent,
  ToolCallEvent,
  ToolResultEvent,
  UserEvent,
} from "../parser/events.js";

// Turn assembly for the transcript viewer. Groups the flat event
// stream into user anchored turns, pairs tool results with their
// calls, nests subagent conversations under the Task call that
// spawned them, and attaches cost so the renderer never touches the
// usage ledger itself.

export interface TextItem {
  kind: "text";
  event: AssistantTextEvent;
}

export interface ThinkingItem {
  kind: "thinking";
  event: ThinkingEvent;
}

// Meta user lines do not start turns and are not conversation. They
// stay in the stream so the renderer can choose to show them dimmed
// or hide them.
export interface MetaItem {
  kind: "meta";
  event: UserEvent;
}

export interface ToolItem {
  kind: "tool";
  call: ToolCallEvent;
  result: ToolResultEvent | undefined;
  // The assembled subagent conversation for a Task call whose
  // sidechain could be linked. Its cost lives in its own turns.
  subagent: Turn[] | undefined;
  // This call's share of its message cost, split evenly across the
  // message's calls, the same rule the tool breakdown uses.
  usd: number | undefined;
}

export type TurnItem = TextItem | ThinkingItem | MetaItem | ToolItem;

export interface Turn {
  // Undefined for events that arrive before the first user prompt,
  // which the renderer must still show rather than lose.
  user: UserEvent | undefined;
  items: TurnItem[];
  // Cost of the api messages in this turn, counted once per message.
  // Undefined when any of them used a model without pricing, so a
  // partial sum is never shown as the real number.
  usd: number | undefined;
  outputTokens: number;
  timestamp: string | undefined;
}

export interface AssembleStats {
  // Tool results whose call never appeared. Rare, means a damaged
  // line upstream.
  orphanResults: number;
}

export interface AssembledTranscript {
  turns: Turn[];
  // Sidechains no Task call claimed, assembled anyway so the
  // renderer can show them after the main conversation.
  orphanSidechains: Turn[][];
  stats: AssembleStats;
}

interface MessageCost {
  usd: number | undefined;
  output: number;
}

interface AssembleContext {
  costByMessage: Map<string, MessageCost>;
  callsPerMessage: Map<string, number>;
  // Sidechains still waiting for a Task call to claim them, in file
  // order. Entries are removed as they are claimed.
  unclaimed: { rootText: string | undefined; events: SessionEvent[] }[];
  stats: AssembleStats;
}

function countCalls(context: AssembleContext, events: SessionEvent[]): void {
  for (const event of events) {
    if (event.kind !== "tool-call" || event.messageId === undefined) continue;
    const count = context.callsPerMessage.get(event.messageId) ?? 0;
    context.callsPerMessage.set(event.messageId, count + 1);
  }
}

function callShare(
  context: AssembleContext,
  messageId: string | undefined,
): number | undefined {
  if (messageId === undefined) return undefined;
  const cost = context.costByMessage.get(messageId);
  if (cost === undefined || cost.usd === undefined) return undefined;
  const count = context.callsPerMessage.get(messageId) ?? 1;
  return cost.usd / count;
}

// The logs carry no id linking a sidechain to the Task call that
// spawned it. The join key is the sidechain's opening user message,
// which repeats the Task call's prompt verbatim. First unclaimed
// match wins, so duplicate prompts pair up in file order.
function claimSidechain(
  context: AssembleContext,
  call: ToolCallEvent,
): Turn[] | undefined {
  const input = call.input;
  if (typeof input !== "object" || input === null) return undefined;
  const prompt = (input as Record<string, unknown>).prompt;
  if (typeof prompt !== "string") return undefined;
  const index = context.unclaimed.findIndex(
    (entry) => entry.rootText === prompt,
  );
  if (index === -1) return undefined;
  const [entry] = context.unclaimed.splice(index, 1);
  if (entry === undefined) return undefined;
  return assembleTurns(entry.events, context, false);
}

function finishTurn(context: AssembleContext, turn: Turn): void {
  const seen = new Set<string>();
  for (const item of turn.items) {
    if (item.kind === "meta") continue;
    const messageId = item.kind === "tool" ? item.call.messageId : item.event.messageId;
    if (messageId === undefined || seen.has(messageId)) continue;
    seen.add(messageId);
  }
  let usd: number | undefined = 0;
  let output = 0;
  for (const messageId of seen) {
    const cost = context.costByMessage.get(messageId);
    if (cost === undefined) continue;
    output += cost.output;
    if (cost.usd === undefined) usd = undefined;
    else if (usd !== undefined) usd += cost.usd;
  }
  turn.usd = usd;
  turn.outputTokens = output;
  turn.timestamp ??= turn.items[0]?.kind === "tool"
    ? turn.items[0].call.timestamp
    : turn.items[0]?.event.timestamp;
}

function assembleTurns(
  events: SessionEvent[],
  context: AssembleContext,
  linkSubagents: boolean,
): Turn[] {
  const turns: Turn[] = [];
  const pendingCalls = new Map<string, ToolItem>();
  let current: Turn | undefined;

  const openTurn = (user: UserEvent | undefined): Turn => {
    const turn: Turn = {
      user,
      items: [],
      usd: undefined,
      outputTokens: 0,
      timestamp: user?.timestamp,
    };
    turns.push(turn);
    return turn;
  };

  for (const event of events) {
    if (event.kind === "user" && !event.isMeta) {
      if (current !== undefined) finishTurn(context, current);
      current = openTurn(event);
      continue;
    }
    if (event.kind === "tool-result") {
      const item =
        event.toolUseId === undefined
          ? undefined
          : pendingCalls.get(event.toolUseId);
      if (item === undefined) {
        context.stats.orphanResults += 1;
      } else {
        item.result = event;
      }
      continue;
    }
    current ??= openTurn(undefined);
    if (event.kind === "user") {
      current.items.push({ kind: "meta", event });
    } else if (event.kind === "assistant-text") {
      current.items.push({ kind: "text", event });
    } else if (event.kind === "thinking") {
      current.items.push({ kind: "thinking", event });
    } else {
      const item: ToolItem = {
        kind: "tool",
        call: event,
        result: undefined,
        subagent: linkSubagents ? claimSidechain(context, event) : undefined,
        usd: callShare(context, event.messageId),
      };
      if (event.toolUseId !== undefined) pendingCalls.set(event.toolUseId, item);
      current.items.push(item);
    }
  }
  if (current !== undefined) finishTurn(context, current);
  return turns;
}

function rootTextOf(events: SessionEvent[]): string | undefined {
  for (const event of events) {
    if (event.kind === "user") return event.text;
  }
  return undefined;
}

export function assembleTranscript(
  session: ExtractedSession,
): AssembledTranscript {
  const costByMessage = new Map<string, MessageCost>();
  for (const entry of session.usage) {
    costByMessage.set(entry.messageId, {
      usd: costOfUsage(entry.usage, entry.model),
      output: entry.usage.output,
    });
  }

  const context: AssembleContext = {
    costByMessage,
    callsPerMessage: new Map(),
    unclaimed: session.sidechains.map((events) => ({
      rootText: rootTextOf(events),
      events,
    })),
    stats: { orphanResults: 0 },
  };
  countCalls(context, session.events);
  for (const group of session.sidechains) countCalls(context, group);

  const turns = assembleTurns(session.events, context, true);
  const orphanSidechains = context.unclaimed.map((entry) =>
    assembleTurns(entry.events, context, false),
  );
  return { turns, orphanSidechains, stats: context.stats };
}
