import { homedir } from "node:os";
import type { SessionSummary } from "../cost/aggregate.js";
import { toolCategory, type ToolCategory } from "../cost/tools.js";
import type { ToolCallEvent, UserEvent } from "../parser/events.js";
import {
  fmtDuration,
  fmtTokens,
  fmtUsd,
  fmtWhen,
  shortId,
  shortModel,
} from "./format.js";
import type { GlyphSet } from "./glyphs.js";
import type { Style } from "./style.js";
import { displayWidth, truncate, truncatePath, wrapPlain } from "./text.js";
import type {
  AssembledTranscript,
  ToolItem,
  Turn,
  TurnItem,
} from "./turns.js";

// Renders an assembled transcript into styled terminal lines. The
// rules come from docs/design.md: dim is the primary tool, structure
// comes from spacing and glyphs, and every style must survive
// removal. Measurement always happens on plain text, styling wraps
// the measured pieces afterward.

export interface RenderContext {
  c: Style;
  g: GlyphSet;
  width: number;
  italic: boolean;
  // Whether color is on. Only affects the few places a style needs
  // different plain and colored shapes, like the header cost chip.
  color: boolean;
  // Expand raw commands, tool outputs, thinking, and meta lines.
  full: boolean;
  // Per call cost badges on tool lines.
  costs: boolean;
  cwd: string | undefined;
  now: Date;
}

const INDENT = "  ";
const RESULT_PREVIEW_LINES = 3;

function pad(depth: number): string {
  return INDENT.repeat(depth);
}

// Left text and a right aligned dim badge on one line. Widths are
// computed on the plain strings, the styled twins are what lands in
// the output.
function twoSided(
  plainLeft: string,
  styledLeft: string,
  plainRight: string,
  styledRight: string,
  width: number,
): string {
  if (plainRight === "") return styledLeft;
  const gap = width - displayWidth(plainLeft) - displayWidth(plainRight);
  return styledLeft + " ".repeat(Math.max(gap, 1)) + styledRight;
}

function toolColor(c: Style, category: ToolCategory): (text: string) => string {
  switch (category) {
    case "bash":
      return c.yellow;
    case "edit":
      return c.green;
    case "read":
      return c.blue;
    case "web":
      return c.magenta;
    case "agents":
      return c.cyan;
    case "mcp":
      return c.magenta;
    default:
      return (text) => text;
  }
}

function shortenPath(path: string, cwd: string | undefined): string {
  if (cwd !== undefined && path.startsWith(`${cwd}/`)) {
    return path.slice(cwd.length + 1);
  }
  const home = homedir();
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

function lineCount(text: unknown): number {
  return typeof text === "string" && text !== "" ? text.split("\n").length : 0;
}

interface ToolLabel {
  label: string;
  // A trailing fragment kept whole while the label truncates, like an
  // edit's line delta. Undefined means none.
  suffix: string | undefined;
  // The label is a path, so truncate from the front to keep the file
  // name rather than the leading directories.
  isPath: boolean;
  // Raw text for the connector line under the label. Undefined means
  // there is nothing beneath.
  detail: string | undefined;
}

// One readable line per call. Bash carries a model written
// description in its input, everything else derives a label from its
// most telling input field.
function toolLabel(call: ToolCallEvent, cwd: string | undefined): ToolLabel {
  const input =
    typeof call.input === "object" && call.input !== null
      ? (call.input as Record<string, unknown>)
      : {};
  const str = (key: string): string | undefined =>
    typeof input[key] === "string" ? (input[key] as string) : undefined;

  const category = toolCategory(call.toolName);
  const path = str("file_path");
  switch (category) {
    case "bash": {
      const command = str("command");
      return {
        label: call.description ?? command ?? call.toolName,
        suffix: undefined,
        isPath: false,
        detail: command,
      };
    }
    case "edit": {
      if (path === undefined) {
        return { label: call.toolName, suffix: undefined, isPath: false, detail: undefined };
      }
      const added = lineCount(input.new_string ?? input.content);
      const removed = lineCount(input.old_string);
      return {
        label: shortenPath(path, cwd),
        suffix: `(+${added} -${removed})`,
        isPath: true,
        detail: undefined,
      };
    }
    case "read": {
      const target = path ?? str("pattern") ?? str("path");
      return {
        label: target === undefined ? call.toolName : shortenPath(target, cwd),
        suffix: undefined,
        isPath: target !== undefined && target.includes("/"),
        detail: undefined,
      };
    }
    case "web": {
      const target = str("url") ?? str("query");
      return { label: target ?? call.toolName, suffix: undefined, isPath: false, detail: undefined };
    }
    case "agents": {
      const label = str("description") ?? str("subagent_type") ?? call.toolName;
      return { label, suffix: undefined, isPath: false, detail: str("prompt") };
    }
    default:
      return { label: call.toolName, suffix: undefined, isPath: false, detail: undefined };
  }
}

function thinkingStyle(ctx: RenderContext, text: string): string {
  return ctx.italic ? ctx.c.dim(ctx.c.italic(text)) : ctx.c.dim(text);
}

export function renderHeader(
  summary: SessionSummary,
  ctx: RenderContext,
): string {
  const { c, g } = ctx;
  const models = summary.models.map(shortModel).join(", ");
  const cost =
    summary.total.unknownModels.length > 0 ? "$?" : fmtUsd(summary.total.usd);
  const parts = [
    models === "" ? undefined : models,
    cost,
    `${summary.turns} ${summary.turns === 1 ? "turn" : "turns"}`,
    summary.durationMs === undefined ? undefined : fmtDuration(summary.durationMs),
  ].filter((part): part is string => part !== undefined);

  // The cost is the one inverse video chip, per the design's header
  // spec. The padding inside the chip only reads as a chip when it
  // has a background, so plain output drops it to avoid stray double
  // spaces. Everything else in the header stays plain or dim.
  const chip = ctx.color ? c.inverse(` ${cost} `) : cost;
  const styledParts = parts
    .map((part) => (part === cost ? chip : part))
    .join(` ${c.dim(g.dot)} `);
  const left = `${c.dim(g.rule)} session ${c.bold(shortId(summary.sessionId))} ${c.dim(g.rule)}`;
  return styledParts === "" ? left : `${left}  ${styledParts}`;
}

function renderUserAnchor(
  user: UserEvent,
  depth: number,
  subagent: boolean,
  ctx: RenderContext,
  out: string[],
): void {
  const { c, g } = ctx;
  const base = pad(depth);
  if (subagent) {
    // A subagent's opening user message is the prompt Claude wrote,
    // machinery rather than the human, so it stays dim and short.
    const label = `${base}${g.user} prompt`;
    out.push(c.dim(label));
    if (ctx.full) {
      for (const line of wrapPlain(user.text, ctx.width - depth * 2 - 2)) {
        out.push(c.dim(`${base}${INDENT}${line}`.trimEnd()));
      }
    } else {
      const first = user.text.split("\n")[0] ?? "";
      out.push(c.dim(`${base}${INDENT}${truncate(first, ctx.width - depth * 2 - 2, g.ellipsis)}`));
    }
    return;
  }
  const plainLeft = `${base}${g.user} YOU`;
  const time = user.timestamp === undefined ? "" : fmtWhen(user.timestamp, ctx.now);
  out.push(
    twoSided(
      plainLeft,
      c.bold(c.cyan(plainLeft)),
      time,
      c.dim(time),
      ctx.width,
    ),
  );
  for (const line of wrapPlain(user.text, ctx.width - depth * 2 - 2)) {
    out.push(c.bold(c.cyan(`${base}${INDENT}${line}`.trimEnd())));
  }
}

function renderClaudeAnchor(turn: Turn, depth: number, ctx: RenderContext, out: string[]): void {
  const { c, g } = ctx;
  const plainLeft = `${pad(depth)}${g.claude} Claude`;
  const badgeParts: string[] = [];
  if (turn.outputTokens > 0) {
    badgeParts.push(`${fmtTokens(turn.outputTokens)} out`);
  }
  badgeParts.push(turn.usd === undefined ? "$?" : fmtUsd(turn.usd));
  const badge = badgeParts.join(` ${g.dot} `);
  out.push(
    twoSided(plainLeft, plainLeft, badge, c.dim(badge), ctx.width),
  );
}

function renderResult(item: ToolItem, depth: number, ctx: RenderContext, out: string[]): void {
  const result = item.result;
  if (result === undefined || result.text === "") return;
  const { c } = ctx;
  const base = pad(depth + 1);
  const available = ctx.width - (depth + 1) * 2;
  const lines = result.text.split("\n");

  if (result.isError) {
    // Errors are the one thing always shown in full. Red, not dim,
    // because a failed call is what a reader scans for.
    for (const line of lines) {
      out.push(c.red(`${base}${line}`.trimEnd()));
    }
    return;
  }
  if (!ctx.full && !shouldPreview(item)) return;
  const preview = ctx.full ? lines : lines.slice(0, RESULT_PREVIEW_LINES);
  for (const line of preview) {
    out.push(c.dim(`${base}${truncate(line, available, ctx.g.ellipsis)}`.trimEnd()));
  }
  if (!ctx.full && lines.length > preview.length) {
    out.push(c.dim(`${base}(${ctx.g.ellipsis} ${lines.length - preview.length} more lines)`));
  }
}

// Machinery results stay hidden by default: the call line already
// says what happened, and read or edit output is noise until the
// reader asks for it. Bash keeps a short preview because its output
// is usually the point of running it.
function shouldPreview(item: ToolItem): boolean {
  return toolCategory(item.call.toolName) === "bash";
}

function renderToolItem(item: ToolItem, depth: number, ctx: RenderContext, out: string[]): void {
  const { c, g } = ctx;
  const base = pad(depth);
  const category = toolCategory(item.call.toolName);
  const glyph = g.tools[category];
  const color = toolColor(c, category);
  const available = ctx.width - depth * 2;

  const { label, suffix, isPath, detail } = toolLabel(item.call, ctx.cwd);
  const suffixText = suffix === undefined ? "" : `  ${suffix}`;
  // Reserve room for the kept suffix, and for a right aligned cost
  // badge only when --costs will actually draw one, so labels get the
  // full width in the common case.
  const badgeReserve = ctx.costs ? 8 : 0;
  const room =
    available - displayWidth(glyph) - 1 - badgeReserve - displayWidth(suffixText);
  const truncated = isPath
    ? truncatePath(label, room, g.ellipsis)
    : truncate(label, room, g.ellipsis);
  const labelText = `${truncated}${suffixText}`;
  const plainLeft = `${base}${glyph} ${labelText}`;
  const styledLeft = `${base}${color(glyph)} ${c.bold(labelText)}`;
  const badge = ctx.costs && item.usd !== undefined ? fmtUsd(item.usd) : "";
  out.push(twoSided(plainLeft, styledLeft, badge, c.dim(badge), ctx.width));

  if (detail !== undefined && category !== "agents") {
    const connectorPad = `${base}${" ".repeat(displayWidth(glyph) + 1)}`;
    const room = ctx.width - displayWidth(connectorPad) - displayWidth(g.connector) - 1;
    if (ctx.full) {
      for (const line of detail.split("\n")) {
        out.push(c.dim(`${connectorPad}${g.connector} ${line}`));
      }
    } else {
      const first = detail.split("\n")[0] ?? "";
      const suffix = detail.includes("\n") ? ` ${g.ellipsis}` : "";
      out.push(
        c.dim(
          `${connectorPad}${g.connector} ${truncate(first, room - displayWidth(suffix), g.ellipsis)}${suffix}`,
        ),
      );
    }
  }

  renderResult(item, depth, ctx, out);

  if (item.subagent !== undefined) {
    renderTurnList(item.subagent, depth + 1, true, ctx, out);
  }
}

function renderItem(item: TurnItem, depth: number, ctx: RenderContext, out: string[]): void {
  const { c } = ctx;
  const base = pad(depth);
  const available = ctx.width - depth * 2;
  if (item.kind === "text") {
    for (const line of wrapPlain(item.event.text, available)) {
      out.push(`${base}${line}`.trimEnd());
    }
  } else if (item.kind === "thinking") {
    const lines = item.event.text.split("\n");
    if (ctx.full) {
      for (const line of wrapPlain(item.event.text, available)) {
        out.push(thinkingStyle(ctx, `${base}${line}`.trimEnd()));
      }
    } else {
      // The thinking glyph already signals collapsed content, so the
      // label just carries the line count, no leading ellipsis.
      out.push(
        thinkingStyle(
          ctx,
          `${base}${ctx.g.thinking} thinking (${lines.length} ${lines.length === 1 ? "line" : "lines"})`,
        ),
      );
    }
  } else if (item.kind === "meta") {
    // Meta lines are bookkeeping the conversation never saw. Only
    // --full shows them, dim.
    if (ctx.full && item.event.text !== "") {
      for (const line of wrapPlain(item.event.text, available)) {
        out.push(c.dim(`${base}${line}`.trimEnd()));
      }
    }
  } else {
    renderToolItem(item, depth, ctx, out);
  }
}

function renderTurnList(
  turns: Turn[],
  depth: number,
  subagent: boolean,
  ctx: RenderContext,
  out: string[],
): void {
  for (const turn of turns) {
    if (out.length > 0) out.push("");
    if (turn.user !== undefined) {
      renderUserAnchor(turn.user, depth, subagent, ctx, out);
    }
    const visible = turn.items.filter(
      (item) => item.kind !== "meta" || ctx.full,
    );
    if (visible.length === 0) continue;
    out.push("");
    if (!subagent) {
      renderClaudeAnchor(turn, depth, ctx, out);
    }
    // The mockup separates prose, tool blocks, and thinking with one
    // blank line, while consecutive tool calls stay packed.
    let previousKind: TurnItem["kind"] | undefined;
    for (const item of visible) {
      if (previousKind !== undefined && item.kind !== previousKind) {
        out.push("");
      }
      renderItem(item, depth + 1, ctx, out);
      previousKind = item.kind;
    }
  }
}

export function renderTranscript(
  assembled: AssembledTranscript,
  summary: SessionSummary,
  ctx: RenderContext,
): string[] {
  const out: string[] = [];
  out.push(renderHeader(summary, ctx));
  renderTurnList(assembled.turns, 0, false, ctx, out);
  for (const group of assembled.orphanSidechains) {
    out.push("");
    out.push(ctx.c.dim(`${ctx.g.tools.agents} subagent (unlinked)`));
    renderTurnList(group, 1, true, ctx, out);
  }
  if (summary.total.unknownModels.length > 0) {
    out.push("");
    out.push(
      ctx.c.dim(
        `some usage has no pricing (${summary.total.unknownModels.map(shortModel).join(", ")}), see ccprism doctor`,
      ),
    );
  }
  return out;
}
