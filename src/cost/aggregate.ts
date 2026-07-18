import type { ExtractedSession, MessageUsage } from "../parser/events.js";
import { costOfUsage } from "./cost.js";

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

// Running total over any group of api messages. usd covers only
// models with known pricing. Tokens for the rest are still counted
// and their ids land in unknownModels, so output can say the cost is
// incomplete instead of showing a wrong number.
export interface UsageRollup {
  messages: number;
  tokens: TokenTotals;
  usd: number;
  unknownModels: string[];
}

export function emptyRollup(): UsageRollup {
  return {
    messages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    usd: 0,
    unknownModels: [],
  };
}

export function addToRollup(rollup: UsageRollup, entry: MessageUsage): void {
  rollup.messages += 1;
  const usage = entry.usage;
  rollup.tokens.input += usage.input;
  rollup.tokens.output += usage.output;
  rollup.tokens.cacheRead += usage.cacheRead;
  // Same fallback as the cost function: totals without a lifetime
  // split count as 5 minute writes.
  rollup.tokens.cacheWrite5m += usage.cacheCreation5m ?? usage.cacheCreationTotal;
  rollup.tokens.cacheWrite1h += usage.cacheCreation1h ?? 0;

  const usd = costOfUsage(usage, entry.model);
  if (usd === undefined) {
    if (!rollup.unknownModels.includes(entry.model)) {
      rollup.unknownModels.push(entry.model);
    }
  } else {
    rollup.usd += usd;
  }
}

export function rollupOf(entries: Iterable<MessageUsage>): UsageRollup {
  const rollup = emptyRollup();
  for (const entry of entries) addToRollup(rollup, entry);
  return rollup;
}

// Groups entries into rollups. Entries whose key comes back
// undefined are dropped, for example usage without a timestamp when
// grouping by day.
export function rollupByKey(
  entries: Iterable<MessageUsage>,
  key: (entry: MessageUsage) => string | undefined,
): Map<string, UsageRollup> {
  const groups = new Map<string, UsageRollup>();
  for (const entry of entries) {
    const k = key(entry);
    if (k === undefined) continue;
    let rollup = groups.get(k);
    if (rollup === undefined) {
      rollup = emptyRollup();
      groups.set(k, rollup);
    }
    addToRollup(rollup, entry);
  }
  return groups;
}

// Local calendar day, so day boundaries follow the user's clock and
// not UTC.
export function dayOf(timestamp: string | undefined): string | undefined {
  if (timestamp === undefined) return undefined;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return undefined;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export interface SessionSummary {
  sessionId: string | undefined;
  projectSlug: string;
  filePath: string;
  cwd: string | undefined;
  gitBranch: string | undefined;
  version: string | undefined;
  models: string[];
  firstTimestamp: string | undefined;
  lastTimestamp: string | undefined;
  durationMs: number | undefined;
  // User messages on the active branch, meta lines excluded.
  turns: number;
  total: UsageRollup;
  // Subsets of total, not additional spend on top of it.
  sidechain: UsageRollup;
  offBranch: UsageRollup;
}

export function summarizeSession(
  file: { filePath: string; projectSlug: string },
  session: ExtractedSession,
): SessionSummary {
  const total = emptyRollup();
  const sidechain = emptyRollup();
  const offBranch = emptyRollup();
  for (const entry of session.usage) {
    addToRollup(total, entry);
    if (entry.isSidechain) addToRollup(sidechain, entry);
    if (!entry.onActiveBranch) addToRollup(offBranch, entry);
  }

  const meta = session.meta;
  let durationMs: number | undefined;
  if (meta.firstTimestamp !== undefined && meta.lastTimestamp !== undefined) {
    const span =
      new Date(meta.lastTimestamp).getTime() -
      new Date(meta.firstTimestamp).getTime();
    if (Number.isFinite(span) && span >= 0) durationMs = span;
  }

  return {
    sessionId: meta.sessionId,
    projectSlug: file.projectSlug,
    filePath: file.filePath,
    cwd: meta.cwd,
    gitBranch: meta.gitBranch,
    version: meta.version,
    models: meta.models,
    firstTimestamp: meta.firstTimestamp,
    lastTimestamp: meta.lastTimestamp,
    durationMs,
    turns: session.events.filter(
      (event) => event.kind === "user" && !event.isMeta,
    ).length,
    total,
    sidechain,
    offBranch,
  };
}
