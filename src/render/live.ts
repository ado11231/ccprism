import type { SessionSummary } from "../cost/aggregate.js";
import type { ExtractedSession } from "../parser/events.js";
import { fmtTokens, fmtUsd, shortModel } from "./format.js";
import type { GlyphSet } from "./glyphs.js";
import type { Style } from "./style.js";

// Shared one-line renderer for the live surfaces: the statusline
// (printed once per assistant message by Claude Code) and watch
// (appended whenever a tailed session changes). Plain text on
// purpose, both surfaces stream to stdout and the line has to read
// with no styling.

// The live context window fill and the model behind it, taken from
// the most recent api call on the main thread. Matches Claude Code's
// own used_percentage, which counts the input side only (fresh input
// plus cache reads plus cache writes), not output.
export interface CurrentContext {
  tokens: number;
  model: string | undefined;
}

export function currentContext(session: ExtractedSession): CurrentContext {
  let latest: (typeof session.usage)[number] | undefined;
  for (const entry of session.usage) {
    if (entry.isSidechain || !entry.onActiveBranch) continue;
    latest = entry;
  }
  if (latest === undefined) return { tokens: 0, model: undefined };
  const u = latest.usage;
  return {
    tokens: u.input + u.cacheRead + u.cacheCreationTotal,
    model: latest.model,
  };
}

// The two row statusline panel:
//
//   opus-4-8  ·  $0.19  ·  2 turns
//   ▓▓▓░░░░░░░░░░░  14%   27.4k / 200k ctx
//
// Each returned string is one row, since Claude Code renders a line
// of output per row. The gauge shifts green to yellow to red as the
// context window fills, which is the one piece of color that carries
// information rather than decoration: it warns before compaction.
// The gauge row is dropped entirely before the first api call, when
// there is no context to report.

export interface PanelOptions {
  c: Style;
  g: GlyphSet;
  // Total context window for the current model, from the session json
  // Claude Code pipes in. Only the size is taken from there; the token
  // count stays ccprism's own so it agrees with view and the dashboard.
  contextWindow: number;
}

const GAUGE_WIDTH = 14;
const GAUGE_WARN = 0.5;
const GAUGE_DANGER = 0.8;

// One color per model family, so a switch is visible at a glance.
// Dim is deliberately not used for any content on this panel: it
// renders as low contrast gray and the statusline is small text on
// someone else's background. Dim is kept for separators only, which
// are structure and should recede.
function modelColor(c: Style, model: string): (text: string) => string {
  if (model.includes("opus")) return c.magenta;
  if (model.includes("sonnet")) return c.blue;
  if (model.includes("haiku")) return c.green;
  if (model.includes("fable")) return c.cyan;
  return (text) => text;
}

function gaugeRow(tokens: number, options: PanelOptions): string {
  const { c, g } = options;
  const ratio = Math.min(tokens / options.contextWindow, 1);
  // Always show at least one filled cell once any context is used, so
  // a low percentage still reads as started rather than empty.
  const filled = Math.min(
    GAUGE_WIDTH,
    Math.max(1, Math.round(ratio * GAUGE_WIDTH)),
  );
  const bar = g.gaugeFull.repeat(filled) + g.gaugeEmpty.repeat(GAUGE_WIDTH - filled);
  const paint =
    ratio >= GAUGE_DANGER ? c.red : ratio >= GAUGE_WARN ? c.yellow : c.green;
  // Percent is padded so the detail column does not jitter as it grows.
  const percent = `${Math.round(ratio * 100)}%`.padStart(4);
  const detail = `${fmtTokens(tokens)} / ${fmtTokens(options.contextWindow)} ctx`;
  // The token detail takes the gauge's color too: it is the same
  // measurement, and it has to stay readable at statusline size.
  return `${paint(bar)}  ${paint(percent)}   ${paint(detail)}`;
}

export function statuslinePanel(
  summary: SessionSummary,
  context: CurrentContext,
  options: PanelOptions,
): string[] {
  const { c } = options;
  const model = context.model ?? summary.models[summary.models.length - 1];
  const cost =
    summary.total.unknownModels.length > 0 ? "$?" : fmtUsd(summary.total.usd);
  const turns = `${summary.turns} ${summary.turns === 1 ? "turn" : "turns"}`;
  const head = [
    model === undefined ? undefined : modelColor(c, model)(shortModel(model)),
    c.bold(cost),
    turns,
  ]
    .filter((part): part is string => part !== undefined)
    .join(c.dim(`  ${options.g.dot}  `));

  const rows = [head];
  if (context.tokens > 0 && options.contextWindow > 0) {
    rows.push(gaugeRow(context.tokens, options));
  }
  return rows;
}

// model · $cost · <ctx> ctx · <turns> turns. Cost is ccprism's own
// number so it matches view and the dashboard; it reads $? when any
// model in the session has no pricing. The context segment drops out
// before the first api call. Kept plain and on one line for watch's
// append log, which pipes to a file.
export function statuslineText(
  summary: SessionSummary,
  context: CurrentContext,
): string {
  const model = context.model ?? summary.models[summary.models.length - 1];
  const cost =
    summary.total.unknownModels.length > 0 ? "$?" : fmtUsd(summary.total.usd);
  const segments = [
    model === undefined ? undefined : shortModel(model),
    cost,
    context.tokens > 0 ? `${fmtTokens(context.tokens)} ctx` : undefined,
    `${summary.turns} ${summary.turns === 1 ? "turn" : "turns"}`,
  ].filter((seg): seg is string => seg !== undefined);
  return segments.join(" · ");
}
