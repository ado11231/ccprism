import {
  burnRatePerHour,
  cacheHitRatio,
  type SessionSummary,
  type TurnDelta,
} from "../cost/aggregate.js";
import type { ExtractedSession } from "../parser/events.js";
import { emptyHostFacts, type HostFacts } from "../parser/host.js";
import { fmtTokens, fmtUsd, shortModel } from "./format.js";
import type { GlyphSet } from "./glyphs.js";
import type { Style } from "./style.js";

// Shared one-line renderer for the live surfaces: the statusline
// (printed once per assistant message by Claude Code) and the compact
// follow log (appended whenever a tailed session changes). Plain text on
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

// The statusline panel, up to four rows, one job each:
//
//   sec-review  ·  opus-4-8  ·  high  ·  2 turns      what is running
//   $0.19  ·  $2.40/hr  ·  $0.03 wasted  ·  +156 −23  what it cost
//   ▓▓▓░░░░░░░░░░░  14%   27.4k / 200k ctx            room left
//   ▓▓▓▓░░░░░░░░░░  24%   5h · 41% week · 89% cache   quota left
//
// Each returned string is one row, since Claude Code renders a line
// of output per row. Every row and every segment within a row drops
// out when its data is missing rather than rendering a zero, so the
// panel shrinks to the two rows it has always been on an api plan
// with nothing to report. That also means a row never half exists:
// no empty gauges, no "$0.00 wasted".
//
// Gauges are the only color that carries information rather than
// decoration. Context and rate limit shift green to yellow to red as
// they fill, warning before compaction and before a cutoff. Cache hit
// is inverted, since a low cache share is the expensive case.

export interface PanelOptions {
  c: Style;
  g: GlyphSet;
  // Total context window for the current model, from the session json
  // Claude Code pipes in. Only the size is taken from there; the token
  // count stays ccprism's own so it agrees with view and the dashboard.
  contextWindow: number;
  // Everything else the host told us about the live session. Defaults
  // to all absent, which is what a manual run from a shell gets.
  host?: HostFacts;
}

const GAUGE_WIDTH = 14;
const GAUGE_WARN = 0.5;
const GAUGE_DANGER = 0.8;

// A cache share this low means most of the prompt is being paid at
// the full input rate, which is the thing worth flagging.
const CACHE_POOR = 0.5;
const CACHE_GOOD = 0.8;

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

type Paint = (text: string) => string;

// Fuller is worse: context filling toward compaction, quota burning
// toward a cutoff.
function fillPaint(c: Style, ratio: number): Paint {
  return ratio >= GAUGE_DANGER ? c.red : ratio >= GAUGE_WARN ? c.yellow : c.green;
}

// Emptier is worse. Kept separate from fillPaint rather than folded in
// as an inverted flag, because the thresholds are genuinely different
// numbers and not a mirror of each other.
function cachePaint(c: Style, ratio: number): Paint {
  return ratio >= CACHE_GOOD ? c.green : ratio >= CACHE_POOR ? c.yellow : c.red;
}

function bar(ratio: number, g: GlyphSet): string {
  // Always show at least one filled cell once anything is used, so a
  // low percentage still reads as started rather than empty.
  const filled = Math.min(
    GAUGE_WIDTH,
    Math.max(1, Math.round(ratio * GAUGE_WIDTH)),
  );
  return g.gaugeFull.repeat(filled) + g.gaugeEmpty.repeat(GAUGE_WIDTH - filled);
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

// A gauge and its percentage, both in the same color. The percent is
// padded so whatever follows it does not jitter as the number grows.
function gauge(ratio: number, paint: Paint, g: GlyphSet): string {
  return `${paint(bar(ratio, g))}  ${paint(pct(ratio).padStart(4))}`;
}

function join(parts: (string | undefined)[], sep: string): string {
  return parts.filter((part): part is string => part !== undefined).join(sep);
}

// Row 1 — which session this is and what is running in it.
function identityRow(
  summary: SessionSummary,
  context: CurrentContext,
  options: PanelOptions,
  host: HostFacts,
): string {
  const { c } = options;
  const model = context.model ?? summary.models[summary.models.length - 1];
  // The session name answers "which of my terminals is this", which is
  // the question a name is for. A subagent's name stands in only when
  // the session has none, rather than taking a second segment.
  const name = host.sessionName ?? host.agentName;
  return join(
    [
      name === undefined ? undefined : c.bold(name),
      model === undefined ? undefined : modelColor(c, model)(shortModel(model)),
      host.effort,
      host.fastMode ? "fast" : undefined,
      `${summary.turns} ${summary.turns === 1 ? "turn" : "turns"}`,
    ],
    c.dim(`  ${options.g.dot}  `),
  );
}

// Row 2 — what it cost. Wasted spend and the line counts are omitted
// at zero: "$0.00 wasted" and "+0 −0" are noise, and their absence is
// the good news.
function costRow(
  summary: SessionSummary,
  options: PanelOptions,
  host: HostFacts,
): string {
  const { c, g } = options;
  const known = summary.total.unknownModels.length === 0;
  const burn = known
    ? burnRatePerHour(summary.total.usd, summary.durationMs)
    : undefined;
  const wasted = known && summary.offBranch.usd > 0 ? summary.offBranch.usd : 0;
  const added = host.linesAdded ?? 0;
  const removed = host.linesRemoved ?? 0;
  return join(
    [
      c.bold(known ? fmtUsd(summary.total.usd) : "$?"),
      burn === undefined ? undefined : `${fmtUsd(burn)}/hr`,
      wasted > 0 ? c.yellow(`${fmtUsd(wasted)} wasted`) : undefined,
      added > 0 || removed > 0
        ? `${c.green(`+${added}`)} ${c.red(`${g.minus}${removed}`)}`
        : undefined,
    ],
    c.dim(`  ${g.dot}  `),
  );
}

// Row 3 — how much of the context window is gone.
function contextRow(tokens: number, options: PanelOptions): string {
  const { c, g } = options;
  const ratio = Math.min(tokens / options.contextWindow, 1);
  const paint = fillPaint(c, ratio);
  const detail = `${fmtTokens(tokens)} / ${fmtTokens(options.contextWindow)} ctx`;
  // The token detail takes the gauge's color too: it is the same
  // measurement, and it has to stay readable at statusline size.
  return `${gauge(ratio, paint, g)}   ${paint(detail)}`;
}

// Row 4 — how much quota is left, plus the cache share, which belongs
// with the limits because it is the other thing silently deciding how
// far the remaining quota goes.
//
// The five hour window gets the bar because it is the one that cuts a
// working session off. When there is no subscription to report, the
// cache share takes the bar instead, so the row still leads with a
// gauge rather than a lone number.
function limitsRow(
  summary: SessionSummary,
  options: PanelOptions,
  host: HostFacts,
): string | undefined {
  const { c, g } = options;
  const cache =
    summary.total.messages > 0 ? cacheHitRatio(summary.total) : undefined;
  const cacheText =
    cache === undefined ? undefined : cachePaint(c, cache)(`${pct(cache)} cache`);
  const sep = c.dim(` ${g.dot} `);

  if (host.fiveHour !== undefined) {
    const ratio = host.fiveHour.usedPercentage / 100;
    const paint = fillPaint(c, ratio);
    const week = host.sevenDay;
    return `${gauge(ratio, paint, g)}   ${join(
      [
        paint("5h"),
        week === undefined
          ? undefined
          : fillPaint(c, week.usedPercentage / 100)(
              `${pct(week.usedPercentage / 100)} week`,
            ),
        cacheText,
      ],
      sep,
    )}`;
  }

  if (cache === undefined) return undefined;
  const paint = cachePaint(c, cache);
  return `${gauge(cache, paint, g)}   ${paint("cache hit")}`;
}

export function statuslinePanel(
  summary: SessionSummary,
  context: CurrentContext,
  options: PanelOptions,
): string[] {
  const host = options.host ?? emptyHostFacts();
  const rows = [
    identityRow(summary, context, options, host),
    costRow(summary, options, host),
  ];
  if (context.tokens > 0 && options.contextWindow > 0) {
    rows.push(contextRow(context.tokens, options));
  }
  const limits = limitsRow(summary, options, host);
  if (limits !== undefined) rows.push(limits);
  return rows;
}

// model · $cost · +$delta · <ctx> ctx · <turns> turns. Cost is
// ccprism's own number so it matches view and the dashboard; it reads
// $? when any model in the session has no pricing. The context segment
// drops out before the first api call. Kept plain and on one line for
// the compact append log, which pipes to a file.
//
// delta is what moved since the last line the compact log printed.
// It sits next to the total so a scan down the log reads as both a
// running total and the price of each turn. It is omitted on the first
// line, when the cost is unknown, and when nothing was added, so a
// delta in the log always means real money moved.
export function statuslineText(
  summary: SessionSummary,
  context: CurrentContext,
  change?: TurnDelta,
): string {
  const model = context.model ?? summary.models[summary.models.length - 1];
  const known = summary.total.unknownModels.length === 0;
  const delta = change?.usd;
  const segments = [
    model === undefined ? undefined : shortModel(model),
    known ? fmtUsd(summary.total.usd) : "$?",
    // Rounded to the same two decimals as the total, so a delta only
    // shows when it moves the printed number. Gated on known too: a
    // total reading $? must never sit beside a precise looking delta.
    known && delta !== undefined && delta >= 0.005
      ? `+${fmtUsd(delta)}`
      : undefined,
    context.tokens > 0 ? `${fmtTokens(context.tokens)} ctx` : undefined,
    `${summary.turns} ${summary.turns === 1 ? "turn" : "turns"}`,
  ].filter((seg): seg is string => seg !== undefined);
  return segments.join(" · ");
}
