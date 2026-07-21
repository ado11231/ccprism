import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { summarizeSession } from "../cost/aggregate.js";
import {
  defaultProjectsRoot,
  discoverSessionFiles,
} from "../parser/discover.js";
import { parseSessionFile } from "../parser/session.js";
import { fmtClock } from "../render/format.js";
import { currentContext, statuslineText } from "../render/live.js";
import { newestSessionPath, type CommandFlags } from "./load.js";

// Tails one session and streams its cost as it changes. The design
// is an append log, not a redraw in place: one timestamped line each
// time the numbers actually move. That stays live in a terminal and
// is still a clean cost log when redirected to a file, which the
// cursor tricks of an in place panel would not be. It follows the
// session resolved at startup for the whole run.

export interface WatchFlags extends CommandFlags {
  id: string | undefined;
}

export interface WatchOptions {
  // One render then return, for tests and non interactive use. The
  // real cli leaves this unset and loops until ctrl-c.
  once?: boolean;
  // Poll cadence in ms, overridable in tests.
  intervalMs?: number;
  now?: () => Date;
  // A programmatic stop, in addition to ctrl-c. The cli never sets
  // it; tests abort it to end the loop without raising SIGINT, which
  // the test runner also listens for.
  signal?: AbortSignal;
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

// The current cost line for a file, undecorated by a timestamp, or
// undefined when it cannot be parsed (a torn write mid append). The
// clock is left off so change detection compares the numbers only:
// the same cost a second later is not a new line.
export async function sessionLine(
  filePath: string,
): Promise<string | undefined> {
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
  return statuslineText(summary, currentContext(parsed.session));
}

// Prints, stamped with the wall clock, only when the cost line moved,
// so an unchanged session stays quiet however often the file is
// touched. A file that momentarily fails to parse keeps the last
// line.
async function emit(
  filePath: string,
  last: string | undefined,
  now: () => Date,
): Promise<string | undefined> {
  const line = await sessionLine(filePath);
  if (line === undefined || line === last) return last;
  console.log(`${fmtClock(now())}  ${line}`);
  return line;
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
  let last = await emit(filePath, undefined, now);
  if (options.once === true) return 0;

  return await new Promise<number>((resolvePromise) => {
    let lastMtime = -1;
    let lastSize = -1;
    const timer = setInterval(async () => {
      let info;
      try {
        info = await stat(filePath);
      } catch {
        return;
      }
      // Re-parse only when the file moved. A growing file is read
      // whole each time; the streaming reader drops any half written
      // trailing line, so a mid append snapshot is safe.
      if (info.mtimeMs === lastMtime && info.size === lastSize) return;
      lastMtime = info.mtimeMs;
      lastSize = info.size;
      last = await emit(filePath, last, now);
    }, options.intervalMs ?? 1000);

    const stop = (): void => {
      clearInterval(timer);
      process.off("SIGINT", stop);
      options.signal?.removeEventListener("abort", stop);
      console.error("");
      resolvePromise(0);
    };
    process.on("SIGINT", stop);
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted === true) stop();
  });
}
