import type { SessionSummary } from "../cost/aggregate.js";
import { fmtDuration, fmtUsd, fmtWhen, shortId, shortModel } from "./format.js";

// Turns a rendered transcript into a file someone else can read: a
// markdown document for gists and pull requests, or one self contained
// html page.
//
// Both take the terminal render as it is rather than re-walking the
// session, so an export can never disagree with what view prints. The
// layout is column based, right aligned badges and all, so both
// formats keep it in a monospace block. Markdown outside the block
// would reflow it into nonsense.

// Exports are written at a fixed width so the same session gives the
// same file whatever the window happened to be.
export const EXPORT_WIDTH = 100;

// The rendered transcript always opens with the header line. Both
// formats replace it with a real title, so it is dropped here.
function body(lines: string[]): string[] {
  return lines.slice(1);
}

function metaLine(summary: SessionSummary): string {
  const parts = [
    summary.models.map(shortModel).join(", "),
    summary.total.unknownModels.length > 0 ? "$?" : fmtUsd(summary.total.usd),
    `${summary.turns} ${summary.turns === 1 ? "turn" : "turns"}`,
    summary.durationMs === undefined ? "" : fmtDuration(summary.durationMs),
    fmtWhen(summary.lastTimestamp),
  ];
  return parts.filter((part) => part !== "").join(" · ");
}

// Four backticks, so a fence inside the transcript cannot close it
// early. Tool output carrying code blocks is ordinary.
const FENCE = "````";

export function toMarkdown(lines: string[], summary: SessionSummary): string {
  return [
    `# session ${shortId(summary.sessionId)}`,
    "",
    metaLine(summary),
    "",
    `${FENCE}text`,
    ...body(lines),
    FENCE,
    "",
  ].join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

interface SgrState {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  inverse: boolean;
  color: number | undefined;
}

function emptyState(): SgrState {
  return { bold: false, dim: false, italic: false, inverse: false, color: undefined };
}

function applyCode(state: SgrState, code: number): void {
  if (code === 0) {
    Object.assign(state, emptyState());
  } else if (code === 1) {
    state.bold = true;
  } else if (code === 2) {
    state.dim = true;
  } else if (code === 3) {
    state.italic = true;
  } else if (code === 7) {
    state.inverse = true;
  } else if (code === 22) {
    // One code turns off both, which is why picocolors can nest bold
    // inside dim and lose the outer one. Same behavior as a terminal.
    state.bold = false;
    state.dim = false;
  } else if (code === 23) {
    state.italic = false;
  } else if (code === 27) {
    state.inverse = false;
  } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
    state.color = code;
  } else if (code === 39) {
    state.color = undefined;
  }
}

function classesFor(state: SgrState): string[] {
  const classes: string[] = [];
  if (state.bold) classes.push("b");
  if (state.dim) classes.push("d");
  if (state.italic) classes.push("i");
  if (state.inverse) classes.push("inv");
  if (state.color !== undefined) classes.push(`c${state.color}`);
  return classes;
}

// An escape, a bracket, some numbers, an m. Nothing else in a
// rendered line is an escape sequence, so this is the whole grammar
// the converter needs.
const SGR = /\u001b\[([0-9;]*)m/g;

// Rewrites the ansi the terminal renderer produced as spans. Keeping
// one renderer for both surfaces means the html cannot drift from what
// the terminal shows, and the color roles come across unchanged.
export function ansiToHtml(text: string): string {
  const state = emptyState();
  let out = "";
  let index = 0;

  // Spans are opened around text, never around a position. picocolors
  // nests by reopening the outer style after an inner one closes, so
  // opening on every code would leave a trail of empty spans.
  const push = (chunk: string): void => {
    if (chunk === "") return;
    const classes = classesFor(state);
    const escaped = escapeHtml(chunk);
    out +=
      classes.length === 0
        ? escaped
        : `<span class="${classes.join(" ")}">${escaped}</span>`;
  };

  SGR.lastIndex = 0;
  let match = SGR.exec(text);
  while (match !== null) {
    push(text.slice(index, match.index));
    for (const raw of (match[1] ?? "").split(";")) {
      applyCode(state, raw === "" ? 0 : Number(raw));
    }
    index = match.index + match[0].length;
    match = SGR.exec(text);
  }
  push(text.slice(index));
  return out;
}

// One file, no scripts, no fonts, nothing fetched. The palette follows
// the reader's theme, the same way the terminal palette follows the
// user's, so the export reads on a light or a dark background.
const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1c1c1c;
  --dim: #6b6b6b;
  --c30: #4a4a4a; --c31: #b3261e; --c32: #1a7f37; --c33: #8a6d00;
  --c34: #0b57d0; --c35: #8b2fb3; --c36: #0f7b8a; --c37: #3d3d3d;
  --c90: #767676; --c91: #b3261e; --c92: #1a7f37; --c93: #8a6d00;
  --c94: #0b57d0; --c95: #8b2fb3; --c96: #0f7b8a; --c97: #1c1c1c;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a;
    --fg: #e6e6e6;
    --dim: #8b8b8b;
    --c30: #7a7a7a; --c31: #ff7b72; --c32: #7ee787; --c33: #e3b341;
    --c34: #79b8ff; --c35: #d2a8ff; --c36: #76e3ea; --c37: #d0d0d0;
    --c90: #8b8b8b; --c91: #ff7b72; --c92: #7ee787; --c93: #e3b341;
    --c94: #79b8ff; --c95: #d2a8ff; --c96: #76e3ea; --c97: #ffffff;
  }
}
body {
  margin: 0;
  padding: 2rem 1rem;
  background: var(--bg);
  color: var(--fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.5;
}
main { max-width: 62rem; margin: 0 auto; }
h1 { font-size: 1.1rem; margin: 0 0 0.25rem; }
.meta { color: var(--dim); margin: 0 0 1.5rem; }
pre { margin: 0; overflow-x: auto; white-space: pre; }
.b { font-weight: 700; }
.d { opacity: 0.65; }
.i { font-style: italic; }
.inv { background: var(--fg); color: var(--bg); }
.c30 { color: var(--c30); } .c31 { color: var(--c31); }
.c32 { color: var(--c32); } .c33 { color: var(--c33); }
.c34 { color: var(--c34); } .c35 { color: var(--c35); }
.c36 { color: var(--c36); } .c37 { color: var(--c37); }
.c90 { color: var(--c90); } .c91 { color: var(--c91); }
.c92 { color: var(--c92); } .c93 { color: var(--c93); }
.c94 { color: var(--c94); } .c95 { color: var(--c95); }
.c96 { color: var(--c96); } .c97 { color: var(--c97); }
`.trim();

export function toHtml(lines: string[], summary: SessionSummary): string {
  const title = `session ${shortId(summary.sessionId)}`;
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    "<main>",
    `<h1>${escapeHtml(title)}</h1>`,
    `<p class="meta">${escapeHtml(metaLine(summary))}</p>`,
    `<pre>${body(lines).map(ansiToHtml).join("\n")}</pre>`,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
