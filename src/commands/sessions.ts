import { rollupOf } from "../cost/aggregate.js";
import {
  fmtDuration,
  fmtUsd,
  fmtWhen,
  renderTable,
  shortId,
  shortModel,
} from "../render/format.js";
import { colorEnabled, makeStyle } from "../render/style.js";
import {
  inWindow,
  loadSessions,
  parseWindow,
  projectLabel,
  type CommandFlags,
  type TimeWindow,
} from "./load.js";

export interface SessionsFlags extends CommandFlags {
  // Rows to show, 0 means all.
  limit: number;
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

  let rows = loaded.map((session) => ({
    session,
    usage: session.usage.filter((u) => inWindow(u.timestamp, window)),
  }));
  if (windowGiven) rows = rows.filter((r) => r.usage.length > 0);
  if (rows.length === 0) {
    console.error("no sessions found");
    return 2;
  }

  rows.sort((a, b) => {
    const at = a.session.summary.lastTimestamp ?? "";
    const bt = b.session.summary.lastTimestamp ?? "";
    return bt.localeCompare(at);
  });
  const limited = flags.limit > 0 ? rows.slice(0, flags.limit) : rows;

  if (flags.json) {
    console.log(
      JSON.stringify(
        limited.map(({ session, usage }) => {
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
            rollup: windowGiven ? rollupOf(usage) : summary.total,
            filePath: summary.filePath,
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
  for (const { session, usage } of limited) {
    const summary = session.summary;
    const rollup = windowGiven ? rollupOf(usage) : summary.total;
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
  const lines = [c.dim(rendered[0] ?? ""), ...rendered.slice(1)];
  if (rows.length > limited.length) {
    lines.push(
      c.dim(`(${rows.length - limited.length} more, use --limit 0 to show all)`),
    );
  }
  console.log(lines.join("\n"));
  return 0;
}
