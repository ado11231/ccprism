import type { ToolCategory } from "../cost/tools.js";

// The transcript's structural marks. Every mark has an ascii twin so
// --ascii can swap the whole set at once, and the two sets share one
// shape so a mark can never exist in only one of them.

export interface GlyphSet {
  user: string;
  claude: string;
  thinking: string;
  // Joins a tool call line to the raw command below it.
  connector: string;
  // Horizontal rule at session boundaries.
  rule: string;
  // Separator between badge fields.
  dot: string;
  // Marks truncation, both inline and in collapse counts.
  ellipsis: string;
  // Leads a removed line count. A true minus, not a hyphen, so it
  // sits at the same width and height as the + beside it.
  minus: string;
  // Filled and empty cells of the context gauge.
  gaugeFull: string;
  gaugeEmpty: string;
  tools: Record<ToolCategory, string>;
}

export const UNICODE_GLYPHS: GlyphSet = {
  user: "●",
  claude: "◆",
  thinking: "⋮",
  connector: "└",
  rule: "─",
  dot: "·",
  ellipsis: "…",
  minus: "−",
  gaugeFull: "▓",
  gaugeEmpty: "░",
  tools: {
    bash: "⚡",
    edit: "✎",
    read: "⌕",
    web: "⛁",
    agents: "◎",
    mcp: "⌘",
    other: "•",
    chat: "◆",
  },
};

export const ASCII_GLYPHS: GlyphSet = {
  user: "*",
  claude: ">",
  thinking: ":",
  connector: "\\_",
  rule: "-",
  dot: ".",
  ellipsis: "...",
  minus: "-",
  gaugeFull: "#",
  gaugeEmpty: "-",
  tools: {
    bash: "$",
    edit: "+",
    read: "?",
    web: "@",
    agents: "&",
    mcp: "%",
    other: "-",
    chat: ">",
  },
};

export function glyphsFor(ascii: boolean): GlyphSet {
  return ascii ? ASCII_GLYPHS : UNICODE_GLYPHS;
}
