import { basename } from "node:path";
import { summarizeSession } from "../cost/aggregate.js";
import type { SessionFile } from "../parser/discover.js";
import { parseSessionFile } from "../parser/session.js";
import {
  renderFollowBody,
  renderHeader,
  type RenderContext,
} from "../render/transcript.js";
import { assembleTranscript, settledTurns } from "../render/turns.js";
import { pollFile, type PollOptions } from "./poll.js";

// Follows a live session and appends the organized transcript as it
// grows. Same output as view, arriving a piece at a time.
//
// The design rule is that a printed line is final. Nothing is ever
// redrawn, so the render must only ever grow: the clock and the
// terminal width are frozen at startup, unsettled turns are held
// back (see settledTurns), and the cost badge waits for the end of
// its turn. Each pass renders the whole settled transcript and
// prints what is past the end of the last one.

export type FollowOptions = PollOptions;

// Index of the first line where two renders disagree, which is the
// length of both when one is a prefix of the other.
function divergence(printed: string[], lines: string[]): number {
  const limit = Math.min(printed.length, lines.length);
  for (let i = 0; i < limit; i += 1) {
    if (printed[i] !== lines[i]) return i;
  }
  return limit;
}

export async function runFollow(
  file: SessionFile,
  ctx: RenderContext,
  options: FollowOptions = {},
): Promise<number> {
  const { filePath } = file;
  // The pointer goes to stderr so a redirect of stdout keeps the
  // transcript clean.
  console.error(`following ${basename(filePath)} — ctrl-c to stop`);

  const printed: string[] = [];
  let opened = false;

  const flush = async (finalize: boolean): Promise<void> => {
    let parsed;
    try {
      parsed = await parseSessionFile(filePath);
    } catch {
      // A torn read mid append. The next pass sees the whole line.
      return;
    }
    const summary = summarizeSession(file, parsed.session);
    if (!opened) {
      // The opening header carries identity only. Totals would be
      // stale a second later, and they get their own line at the end.
      console.log(renderHeader(summary, ctx, false));
      opened = true;
    }

    const assembled = assembleTranscript(parsed.session);
    const turns = finalize ? assembled.turns : settledTurns(assembled.turns);
    const lines = renderFollowBody(turns, ctx, finalize);

    const start = divergence(printed, lines);
    if (start < printed.length) {
      // Held back content is never printed early, so this only
      // happens when the log itself is rewritten: a retry, or a
      // branch switch. Nothing on screen can be taken back, so say
      // the output above is stale and print the branch that won.
      console.log(
        ctx.c.dim(`${ctx.g.ellipsis} transcript changed, lines above are stale`),
      );
    }
    for (const line of lines.slice(start)) console.log(line);
    printed.length = 0;
    printed.push(...lines);

    if (finalize) {
      // The closing line is the same header with its numbers, which
      // are true now that the stream is over.
      console.log("");
      console.log(renderHeader(summary, ctx));
    }
  };

  return await pollFile(
    filePath,
    { ...options, onStop: () => flush(true) },
    () => flush(false),
  );
}
