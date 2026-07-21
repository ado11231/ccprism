import type { SessionSummary } from "../cost/aggregate.js";
import type { ExtractedSession } from "../parser/events.js";
import { fmtTokens, fmtUsd, shortModel } from "./format.js";

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

// model · $cost · <ctx> ctx · <turns> turns. Cost is ccprism's own
// number so it matches view and the dashboard; it reads $? when any
// model in the session has no pricing. The context segment drops out
// before the first api call.
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
