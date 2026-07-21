import { basename, dirname } from "node:path";
import { summarizeSession, type SessionSummary } from "../cost/aggregate.js";
import {
  defaultProjectsRoot,
  discoverSessionFiles,
} from "../parser/discover.js";
import { parseSessionFile } from "../parser/session.js";
import { fmtClock } from "../render/format.js";
import {
  currentContext,
  statuslineText,
  type CurrentContext,
} from "../render/live.js";
import { newestSessionPath, type CommandFlags } from "./load.js";
import { pollFile, type PollOptions } from "./poll.js";

// Tails one session and streams its cost as it changes. The design
// is an append log, not a redraw in place: one timestamped line each
// time the numbers actually move. That stays live in a terminal and
// is still a clean cost log when redirected to a file, which the
// cursor tricks of an in place panel would not be. It follows the
// session resolved at startup for the whole run.

export interface WatchFlags extends CommandFlags {
  id: string | undefined;
}

export interface WatchOptions extends PollOptions {
  now?: () => Date;
}

type Target = { filePath: string } | { code: number };

async function resolveTarget(flags: WatchFlags): Promise<Target> {
  const root = flags.root ?? defaultProjectsRoot();
  if (flags.id === undefined) {
    const path = await newestSessionPath(root);
    if (path === undefined) {
      console.error("no sessions found");
      return { code: 2 };
    }
    return { filePath: path };
  }
  const id = flags.id;
  const matches = (await discoverSessionFiles(root)).filter((file) =>
    file.sessionId.startsWith(id),
  );
  if (matches.length === 0) {
    console.error(`no session matching ${id}`);
    return { code: 2 };
  }
  if (matches.length > 1) {
    console.error(`ambiguous session id ${id}, matches:`);
    for (const file of matches.slice(0, 10)) console.error(`  ${file.sessionId}`);
    return { code: 1 };
  }
  return { filePath: (matches[0] as { filePath: string }).filePath };
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
  // Session cost so far, or undefined when a model has no pricing and
  // no delta can honestly be taken from it.
  usd: number | undefined;
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
  return {
    summary,
    context,
    text: statuslineText(summary, context),
    usd:
      summary.total.unknownModels.length > 0 ? undefined : summary.total.usd,
  };
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
  const line = statuslineText(snapshot.summary, snapshot.context, last?.usd);
  console.log(`${fmtClock(now())}  ${line}`);
  return snapshot;
}

export async function runWatch(
  flags: WatchFlags,
  options: WatchOptions = {},
): Promise<number> {
  const target = await resolveTarget(flags);
  if ("code" in target) return target.code;
  const { filePath } = target;
  const now = options.now ?? (() => new Date());

  // Header goes to stderr so a redirect of stdout captures only the
  // cost lines.
  console.error(`watching ${basename(filePath)} — ctrl-c to stop`);

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
