import { resolve } from "node:path";
import { summarizeSession } from "../cost/aggregate.js";
import {
  defaultProjectsRoot,
  discoverSessionFiles,
} from "../parser/discover.js";
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
import type { CommandFlags } from "./load.js";

export interface ViewFlags extends CommandFlags {
  id: string | undefined;
  full: boolean;
  costs: boolean;
  ascii: boolean;
}

export async function runView(flags: ViewFlags): Promise<number> {
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
      return 1;
    }
  }

  const wantedCwd =
    flags.project === undefined ? undefined : resolve(flags.project);

  // Newest first, parsing one file at a time so the common case
  // touches a single file. Without an explicit id, files that hold
  // no conversation are skipped. Claude Code writes stub files with
  // only bookkeeping lines, and the newest file is often one.
  for (const file of candidates) {
    const parsed = await parseSessionFile(file.filePath);
    const summary = summarizeSession(file, parsed.session);
    if (wantedCwd !== undefined && summary.cwd !== wantedCwd) continue;
    if (flags.id === undefined && parsed.session.events.length === 0) continue;

    const assembled = assembleTranscript(parsed.session);
    if (flags.json) {
      console.log(
        JSON.stringify(
          {
            summary,
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
    const ctx: RenderContext = {
      c: makeStyle(enabled),
      g: glyphsFor(flags.ascii),
      width: contentWidth(),
      italic: enabled && supportsItalic(),
      full: flags.full,
      costs: flags.costs,
      cwd: parsed.session.meta.cwd,
      now: new Date(),
    };
    console.log(renderTranscript(assembled, summary, ctx).join("\n"));
    return 0;
  }

  console.error(
    flags.id === undefined ? "no sessions found" : `no session matching ${flags.id}`,
  );
  return 2;
}
