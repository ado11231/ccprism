// The session JSON Claude Code pipes to a statusLine command on
// stdin. Schema: code.claude.com/docs/en/statusline.
//
// Everything here is best effort by design. The shape is Claude
// Code's, not ours, and it drifts between releases: fields appear,
// and several are absent by plan rather than by accident. So every
// read is guarded and every field is optional. A key that is missing,
// null, or the wrong type reads as undefined and its part of the
// panel simply does not render. Nothing in this file throws.

export interface RateLimit {
  // Percentage of the window consumed, 0 to 100 as the host sends it.
  usedPercentage: number;
}

export interface HostFacts {
  // Names the exact session file, so the statusline never has to
  // guess the active session by mtime.
  transcriptPath: string | undefined;
  contextWindow: number | undefined;
  // Custom name from --name or /rename, else the generated title.
  // Absent for the default display name like "my-app-3f".
  sessionName: string | undefined;
  // Set while a named subagent holds the session.
  agentName: string | undefined;
  // low | medium | high | xhigh | max. Absent when the current model
  // has no effort parameter.
  effort: string | undefined;
  fastMode: boolean;
  linesAdded: number | undefined;
  linesRemoved: number | undefined;
  // Claude.ai subscribers only, and only after the first response of
  // the session. Each window can be absent on its own.
  fiveHour: RateLimit | undefined;
  sevenDay: RateLimit | undefined;
}

export function emptyHostFacts(): HostFacts {
  return {
    transcriptPath: undefined,
    contextWindow: undefined,
    sessionName: undefined,
    agentName: undefined,
    effort: undefined,
    fastMode: false,
    linesAdded: undefined,
    linesRemoved: undefined,
    fiveHour: undefined,
    sevenDay: undefined,
  };
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

// Non-empty strings only: the host sends "" for some fields it has no
// value for, and an empty badge is worse than no badge.
function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

// Percentages outside 0..100 would push a gauge past its ends, so
// they are dropped rather than clamped: an impossible number means
// the field is not what we think it is.
function rateLimit(value: unknown): RateLimit | undefined {
  const used = num(obj(value).used_percentage);
  if (used === undefined || used < 0 || used > 100) return undefined;
  return { usedPercentage: used };
}

export function parseHostJson(raw: string | undefined): HostFacts {
  const facts = emptyHostFacts();
  if (raw === undefined) return facts;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return facts;
  }
  const root = obj(value);
  const cost = obj(root.cost);
  const limits = obj(root.rate_limits);

  facts.transcriptPath = str(root.transcript_path);
  const window = num(obj(root.context_window).context_window_size);
  facts.contextWindow = window !== undefined && window > 0 ? window : undefined;
  facts.sessionName = str(root.session_name);
  facts.agentName = str(obj(root.agent).name);
  facts.effort = str(obj(root.effort).level);
  facts.fastMode = root.fast_mode === true;
  facts.linesAdded = num(cost.total_lines_added);
  facts.linesRemoved = num(cost.total_lines_removed);
  facts.fiveHour = rateLimit(limits.five_hour);
  facts.sevenDay = rateLimit(limits.seven_day);
  return facts;
}
