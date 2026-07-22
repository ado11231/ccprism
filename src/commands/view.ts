import { resolve } from "node:path";
import { summarizeSession } from "../cost/aggregate.js";
import {
  defaultProjectsRoot,
  discoverSessionFiles,
  type SessionFile,
} from "../parser/discover.js";
import type { ExtractedSession } from "../parser/events.js";
import { parseSessionFile } from "../parser/session.js";
import { glyphsFor } from "../render/glyphs.js";
import {
  colorEnabled,
  makeStyle,
  supportsItalic,
} from "../render/style.js";
import { contentWidth } from "../render/text.js";
import { renderTranscript, type RenderContext } from "../render/transcript.js";
import { assembleTranscript } from "../render/turns.js";
import { runCompact, type CompactOptions } from "./compact.js";
import { runFollow } from "./follow.js";
import type { CommandFlags } from "./load.js";

export interface ViewFlags extends CommandFlags {
  id: string | undefined;
  full: boolean;
  costs: boolean;
  ascii: boolean;
  follow: boolean;
  // The live cost log instead of the live transcript. Only a mode of
  // follow, never a shape of the static render, since the static
  // render is already the compact one and --full is its expansion.
  compact: boolean;
}

// Both live modes poll, so they take the same options.
export type ViewOptions = CompactOptions;

type Target =
  | { file: SessionFile; session: ExtractedSession }
  | { code: number };

// Picks the session to render: the id prefix when given, the newest
// otherwise. Files are parsed newest first, one at a time, so the
// common case touches a single file. Without an explicit id, files
// that hold no conversation are skipped. Claude Code writes stub
// files with only bookkeeping lines, and the newest file is often
// one.
async function resolveTarget(flags: ViewFlags): Promise<Target> {
  const files = await discoverSessionFiles(flags.root ?? defaultProjectsRoot());

  let candidates = files;
  if (flags.id !== undefined) {
    const id = flags.id;
    candidates = files.filter((file) => file.sessionId.startsWith(id));
    if (candidates.length > 1) {
      console.error(`ambiguous session id ${id}, matches:`);
      for (const file of candidates.slice(0, 10)) {
        console.error(`  ${file.sessionId}`);
      }
      return { code: 1 };
    }
  }

  const wantedCwd =
    flags.project === undefined ? undefined : resolve(flags.project);

  for (const file of candidates) {
    const parsed = await parseSessionFile(file.filePath);
    if (wantedCwd !== undefined) {
      const summary = summarizeSession(file, parsed.session);
      if (summary.cwd !== wantedCwd) continue;
    }
    if (flags.id === undefined && parsed.session.events.length === 0) continue;
    return { file, session: parsed.session };
  }

  console.error(
    flags.id === undefined ? "no sessions found" : `no session matching ${flags.id}`,
  );
  return { code: 2 };
}

export async function runView(
  flags: ViewFlags,
  options: ViewOptions = {},
): Promise<number> {
  if (flags.compact && !flags.follow) {
    console.error(
      "--compact is a mode of --follow, try: ccprism view --follow --compact",
    );
    return 2;
  }

  const target = await resolveTarget(flags);
  if ("code" in target) return target.code;
  const { file, session } = target;

  // The compact log is plain text with no transcript behind it, so it
  // never builds a render context.
  if (flags.follow && flags.compact) {
    if (flags.json) {
      console.error("--compact has no --json output yet");
      return 2;
    }
    return await runCompact(file.filePath, options);
  }

  if (flags.json) {
    if (flags.follow) {
      console.error("--follow has no --json output yet");
      return 2;
    }
    const assembled = assembleTranscript(session);
    console.log(
      JSON.stringify(
        {
          summary: summarizeSession(file, session),
          turns: assembled.turns,
          orphanSidechains: assembled.orphanSidechains,
          stats: assembled.stats,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const enabled = colorEnabled(flags.color);
  // Width and the clock are read once. Follow mode prints the
  // difference against what it printed last pass, so anything that
  // feeds a rendered line has to hold still for the whole run.
  const ctx: RenderContext = {
    c: makeStyle(enabled),
    g: glyphsFor(flags.ascii),
    width: contentWidth(),
    italic: enabled && supportsItalic(),
    color: enabled,
    full: flags.full,
    costs: flags.costs,
    cwd: session.meta.cwd,
    now: new Date(),
  };

  if (flags.follow) return await runFollow(file, ctx, options);

  const assembled = assembleTranscript(session);
  const summary = summarizeSession(file, session);
  console.log(renderTranscript(assembled, summary, ctx).join("\n"));
  return 0;
}
