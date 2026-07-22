import { basename, dirname } from "node:path";
import {
  summarizeSession,
  turnDelta,
  type SessionSummary,
} from "../cost/aggregate.js";
import { parseSessionFile } from "../parser/session.js";
import { fmtClock } from "../render/format.js";
import {
  currentContext,
  statuslineText,
  type CurrentContext,
} from "../render/live.js";
import { pollFile, type PollOptions } from "./poll.js";

// The compact mode of view --follow: one timestamped line each time
// the numbers actually move, instead of the transcript. This was the
// watch command, and it is an append log rather than a redraw in
// place. That stays live in a terminal and is still a clean cost log
// when redirected to a file, which the cursor tricks of an in place
// panel would not be.

export interface CompactOptions extends PollOptions {
  now?: () => Date;
}

export interface SessionSnapshot {
  summary: SessionSummary;
  context: CurrentContext;
  // The cost line with no clock and no delta. Change detection
  // compares exactly this. The delta has to stay out of it: a line
  // carrying "+$0.00" would differ from the stored one on every tick
  // and print forever, so the compared text and the printed text are
  // deliberately two renders of the same snapshot.
  text: string;
}

// The current state of a file, or undefined when it cannot be parsed
// (a torn write mid append).
export async function sessionSnapshot(
  filePath: string,
): Promise<SessionSnapshot | undefined> {
  let parsed;
  try {
    parsed = await parseSessionFile(filePath);
  } catch {
    return undefined;
  }
  const summary = summarizeSession(
    { filePath, projectSlug: basename(dirname(filePath)) },
    parsed.session,
  );
  const context = currentContext(parsed.session);
  return { summary, context, text: statuslineText(summary, context) };
}

// Prints, stamped with the wall clock, only when the cost line moved,
// so an unchanged session stays quiet however often the file is
// touched. A file that momentarily fails to parse keeps the last
// snapshot, so the next delta spans the gap rather than being lost.
async function emit(
  filePath: string,
  last: SessionSnapshot | undefined,
  now: () => Date,
): Promise<SessionSnapshot | undefined> {
  const snapshot = await sessionSnapshot(filePath);
  if (snapshot === undefined || snapshot.text === last?.text) return last;
  const delta = turnDelta(last?.summary.total, snapshot.summary.total);
  const line = statuslineText(snapshot.summary, snapshot.context, delta);
  console.log(`${fmtClock(now())}  ${line}`);
  return snapshot;
}

export async function runCompact(
  filePath: string,
  options: CompactOptions = {},
): Promise<number> {
  const now = options.now ?? (() => new Date());

  // Header goes to stderr so a redirect of stdout captures only the
  // cost lines.
  console.error(`following ${basename(filePath)} — ctrl-c to stop`);

  // The poller re-reads only when the file moved. A growing file is
  // read whole each time; the streaming reader drops any half written
  // trailing line, so a mid append snapshot is safe.
  let last: SessionSnapshot | undefined;
  return await pollFile(
    filePath,
    { ...options, onStop: () => console.error("") },
    async () => {
      last = await emit(filePath, last, now);
    },
  );
}
