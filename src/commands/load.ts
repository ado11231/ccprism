import { resolve } from "node:path";
import { summarizeSession, type SessionSummary } from "../cost/aggregate.js";
import {
  defaultProjectsRoot,
  discoverSessionFiles,
  type SessionFile,
} from "../parser/discover.js";
import type { ExtractedSession, MessageUsage } from "../parser/events.js";
import { parseSessionFile } from "../parser/session.js";
import type { TreeStats } from "../parser/tree.js";
import type { ReadStats } from "../parser/types.js";

// Parsed values of the flags every command accepts. root exists so
// tests can point at a fixture directory, it is not a cli flag.
export interface CommandFlags {
  json: boolean;
  color: boolean;
  project: string | undefined;
  since: string | undefined;
  until: string | undefined;
  root?: string;
}

export interface TimeWindow {
  since?: Date;
  until?: Date;
}

export interface LoadedSession {
  file: SessionFile;
  summary: SessionSummary;
  // The full extraction, kept because tool attribution needs events
  // and not just the usage ledger.
  extracted: ExtractedSession;
  usage: MessageUsage[];
  readStats: ReadStats;
  treeStats: TreeStats;
  unknownBlocks: number;
}

// Accepts a bare day or anything Date can parse. A bare day means
// local midnight, and the end of the window stretches to the last
// millisecond of that day so --until is inclusive.
export function parseWindow(flags: CommandFlags): TimeWindow {
  return {
    since: parseDate(flags.since, false),
    until: parseDate(flags.until, true),
  };
}

function parseDate(value: string | undefined, endOfDay: boolean): Date | undefined {
  if (value === undefined) return undefined;
  const bareDay = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(bareDay ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid date: ${value} (expected YYYY-MM-DD or an ISO timestamp)`);
  }
  if (bareDay && endOfDay) date.setHours(23, 59, 59, 999);
  return date;
}

export function inWindow(
  timestamp: string | undefined,
  window: TimeWindow,
): boolean {
  if (window.since === undefined && window.until === undefined) return true;
  if (timestamp === undefined) return false;
  const time = new Date(timestamp).getTime();
  if (Number.isNaN(time)) return false;
  if (window.since !== undefined && time < window.since.getTime()) return false;
  if (window.until !== undefined && time > window.until.getTime()) return false;
  return true;
}

export async function loadSessions(
  flags: CommandFlags,
): Promise<LoadedSession[]> {
  const files = await discoverSessionFiles(flags.root ?? defaultProjectsRoot());
  const wantedCwd =
    flags.project === undefined ? undefined : resolve(flags.project);

  const loaded: LoadedSession[] = [];
  for (const file of files) {
    const parsed = await parseSessionFile(file.filePath);
    const summary = summarizeSession(file, parsed.session);
    if (wantedCwd !== undefined && summary.cwd !== wantedCwd) continue;
    loaded.push({
      file,
      summary,
      extracted: parsed.session,
      usage: parsed.session.usage,
      readStats: parsed.readStats,
      treeStats: parsed.treeStats,
      unknownBlocks: parsed.session.stats.unknownBlocks,
    });
  }
  return loaded;
}

// Display name for a session's project: the last path segment of the
// real cwd when the log carries one, the encoded slug otherwise.
export function projectLabel(summary: SessionSummary): string {
  if (summary.cwd !== undefined && summary.cwd !== "") {
    const segments = summary.cwd.split("/").filter((s) => s !== "");
    const last = segments[segments.length - 1];
    if (last !== undefined) return last;
  }
  return summary.projectSlug;
}
