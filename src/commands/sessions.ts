import { rollupOf, type UsageRollup } from "../cost/aggregate.js";
import type { ExtractedSession } from "../parser/events.js";
import {
  fmtDuration,
  fmtUsd,
  fmtWhen,
  renderTable,
  shortId,
  shortModel,
} from "../render/format.js";
import { colorEnabled, makeStyle } from "../render/style.js";
import { contentWidth, truncate } from "../render/text.js";
import {
  inWindow,
  loadSessions,
  parseWindow,
  projectLabel,
  type CommandFlags,
  type LoadedSession,
  type TimeWindow,
} from "./load.js";

export const SESSION_SORTS = ["time", "cost", "duration", "turns"] as const;
export type SessionSort = (typeof SESSION_SORTS)[number];

export interface SessionsFlags extends CommandFlags {
  // Rows to show, 0 means all.
  limit: number;
  // Every sort runs biggest first, since the reason to sort by a
  // number is to see the top of it. time means newest first.
  sort: SessionSort;
  // Keeps sessions that used a model whose id contains this text.
  model: string | undefined;
  // Keeps sessions where a prompt contains this text, and shows the
  // prompt that matched.
  grep: string | undefined;
}

interface Row {
  session: LoadedSession;
  rollup: UsageRollup;
  // The matching prompt, already cut to one line. Only set by --grep.
  snippet: string | undefined;
}

// Enough leading context that the match is not the first thing on the
// line, but not so much that the snippet is all lead in.
const SNIPPET_LEAD = 24;

// The first prompt containing the text, as one line built around the
// match. Undefined when no prompt in the session contains it.
//
// Only the user's own prompts are searched. Meta lines are Claude
// Code's bookkeeping and tool results are output, so matching either
// would answer a question nobody asked.
function promptMatch(
  session: ExtractedSession,
  needle: string,
  width: number,
  ellipsis: string,
): string | undefined {
  for (const event of session.events) {
    if (event.kind !== "user" || event.isMeta) continue;
    // Newlines collapse first, so the snippet is one line whatever the
    // prompt looked like, and the match position stays true.
    const flat = event.text.replace(/\s+/g, " ").trim();
    const at = flat.toLowerCase().indexOf(needle);
    if (at === -1) continue;
    const start = Math.max(0, at - SNIPPET_LEAD);
    const head = start === 0 ? "" : ellipsis;
    return `${head}${truncate(flat.slice(start), width - head.length, ellipsis)}`;
  }
  return undefined;
}

function sortValue(row: Row, sort: SessionSort): number {
  const summary = row.session.summary;
  switch (sort) {
    case "cost":
      return row.rollup.usd;
    case "duration":
      return summary.durationMs ?? 0;
    case "turns":
      return summary.turns;
    default: {
      const time = new Date(summary.lastTimestamp ?? 0).getTime();
      return Number.isNaN(time) ? 0 : time;
    }
  }
}

export async function runSessions(flags: SessionsFlags): Promise<number> {
  let window: TimeWindow;
  try {
    window = parseWindow(flags);
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }

  const loaded = await loadSessions(flags);
  const windowGiven = window.since !== undefined || window.until !== undefined;
  const needle = flags.grep?.toLowerCase();
  const model = flags.model?.toLowerCase();
  // The snippet sits under the row, indented by two, so it gets the
  // rest of the line.
  const snippetWidth = Math.max(20, contentWidth() - 2);

  let rows: Row[] = [];
  for (const session of loaded) {
    const usage = session.usage.filter((u) => inWindow(u.timestamp, window));
    if (windowGiven && usage.length === 0) continue;
    if (
      model !== undefined &&
      !session.summary.models.some((id) => id.toLowerCase().includes(model))
    ) {
      continue;
    }
    let snippet: string | undefined;
    if (needle !== undefined) {
      snippet = promptMatch(session.extracted, needle, snippetWidth, "…");
      if (snippet === undefined) continue;
    }
    rows.push({
      session,
      // Windowed rows report only the usage inside the window, so the
      // cost sort has to rank the same number the row shows.
      rollup: windowGiven ? rollupOf(usage) : session.summary.total,
      snippet,
    });
  }

  if (rows.length === 0) {
    console.error("no sessions found");
    return 2;
  }

  rows.sort((a, b) => sortValue(b, flags.sort) - sortValue(a, flags.sort));
  const limited = flags.limit > 0 ? rows.slice(0, flags.limit) : rows;

  if (flags.json) {
    console.log(
      JSON.stringify(
        limited.map(({ session, rollup, snippet }) => {
          const summary = session.summary;
          return {
            sessionId: summary.sessionId,
            project: projectLabel(summary),
            cwd: summary.cwd ?? null,
            gitBranch: summary.gitBranch ?? null,
            firstTimestamp: summary.firstTimestamp ?? null,
            lastTimestamp: summary.lastTimestamp ?? null,
            durationMs: summary.durationMs ?? null,
            longestGapMs: summary.longestGapMs ?? null,
            turns: summary.turns,
            models: summary.models,
            rollup,
            filePath: summary.filePath,
            promptMatch: snippet ?? null,
          };
        }),
        null,
        2,
      ),
    );
    return 0;
  }

  const c = makeStyle(colorEnabled(flags.color));
  const table: string[][] = [
    ["id", "when", "dur", "turns", "cost", "project", "model"],
  ];
  for (const { session, rollup } of limited) {
    const summary = session.summary;
    const models = summary.models.map(shortModel);
    table.push([
      shortId(summary.sessionId),
      fmtWhen(summary.lastTimestamp),
      summary.durationMs === undefined ? "?" : fmtDuration(summary.durationMs),
      String(summary.turns),
      fmtUsd(rollup.usd) + (rollup.unknownModels.length > 0 ? "+?" : ""),
      projectLabel(summary),
      models.length === 0 ? "?" : (models[0] ?? "?") + (models.length > 1 ? "+" : ""),
    ]);
  }

  const rendered = renderTable(table, [
    "left", "left", "right", "right", "right", "left", "left",
  ]);
  // A matched prompt goes under its own row, indented and dim, so the
  // table still reads as a table and the snippet reads as evidence.
  const lines = [c.dim(rendered[0] ?? "")];
  rendered.slice(1).forEach((line, index) => {
    lines.push(line);
    const snippet = limited[index]?.snippet;
    if (snippet !== undefined) lines.push(c.dim(`  ${snippet}`));
  });
  if (rows.length > limited.length) {
    lines.push(
      c.dim(`(${rows.length - limited.length} more, use --limit 0 to show all)`),
    );
  }
  console.log(lines.join("\n"));
  return 0;
}
