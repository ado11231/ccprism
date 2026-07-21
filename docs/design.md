# Design

## 1. Data source

Claude Code writes one JSONL file per session:

```
~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl
```

Each line is an event. The ones we care about:

| Event | Key fields | Used for |
|---|---|---|
| user message | `message.content`, `timestamp` | transcript |
| assistant message | `message.model`, `message.usage`, content blocks | transcript + metrics |
| `usage` block | `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` | cost math |
| tool_use content block | `name`, `input` (Bash calls include `input.description`!) | transcript one-liners |
| tool_result | output text, `is_error` | transcript (errors stay expanded) |
| `type: "last-prompt"` | `leafUuid` | finding the active branch |
| `isSidechain: true` | — | subagent attribution |

**Critical structural fact:** messages form a **tree** via `parentUuid`
(retries, branches, sidechains). Rendering or costing in raw line order is
wrong. Resolve the active branch by walking backward from `leafUuid`.

**Critical costing fact (verified against real logs, CC ~2026-07):** one API
response is written as **multiple `assistant` lines — one per content block —
each repeating the identical `message.usage` object.** Summing usage per line
multiplies real cost. Dedupe by `message.id` before any aggregation.

Known ignorable types seen in real logs: `agent-name`, `ai-title`,
`file-history-delta`, `file-history-snapshot`, `mode`, `permission-mode`,
`pr-link`, `queue-operation`, `summary`. The parser keeps two skip buckets
(known ignorable vs genuinely unknown or malformed) and `doctor` only flags
the latter. `leafUuid` lives on `last-prompt` events (several per session;
use the last).

**Tree membership fact (verified against real logs 2026-07-17):** `system`
and `attachment` lines carry `uuid` and `parentUuid` and sit inside the
message tree. User and assistant lines can have them as parents, so the
parser must keep every line that has a uuid, whatever its type, or walking
back from `leafUuid` breaks. Unknown future types with a uuid are kept for
the same reason and only counted for `doctor`.

**Compaction fact (verified against real logs 2026-07-17):** compaction
starts a fresh physical tree inside the same file. The new root is a
`system` line with `subtype: "compact_boundary"`, `parentUuid: null`, and a
`logicalParentUuid` pointing at the pre compact conversation. The branch
walk must follow `logicalParentUuid` when `parentUuid` is null, or
everything before the compaction is silently dropped (verified: 1845 of
2412 lines lost in one real session). The boundary line also carries
`compactMetadata` with pre and post token counts.

**Stub session fact (verified 2026-07-17):** a session file can hold only
metadata lines (`agent-name` and `ai-title`) with no tree at all, left
behind when a session is created and immediately abandoned. These parse to
zero kept lines and zero usage. `doctor` treats them as empty sessions,
not parse problems.

The session's own uuid can also appear as a companion directory next to the
jsonl file, holding `tool-results/*.txt` with large tool outputs stored out
of line.

Session metadata worth extracting: `version` (Claude Code version), `cwd`,
`gitBranch`, timestamps (→ duration, gaps, turns).

## 2. Parser (module 1 — zero internal deps)

Emits a typed event stream:

```ts
type Event =
  | UserMessage      // text, timestamp
  | AssistantText    // text, model, usage
  | Thinking         // text (render dim/italic/collapsed)
  | ToolCall         // toolName, description?, input, sidechain?
  | ToolResult       // text, isError, toolUseId
  | Meta             // session header info
```

Requirements:
- Streaming line reader (sessions can be tens of MB)
- Skip-and-count malformed lines; expose counts for `doctor`
- Tree resolution: `leafUuid` → active branch; sidechains grouped under their
  spawning Task call
- Fixtures from real sessions, pinned per Claude Code version

## 3. Cost engine (module 2)

`pricing.json`, keyed by model ID, five tiers per model (USD per MTok):

```json
{
  "claude-opus-4-8": { "input": _, "output": _, "cacheRead": _,
                       "cacheWrite5m": _, "cacheWrite1h": _ }
}
```

- `cost(usage, model)` → number | `unknown` (unknown model ≠ crash; dashboard
  shows tokens with a "pricing unknown" marker)
- **Cache-write tiering (decided 2026-07-17):** real logs split
  `cache_creation` into `ephemeral_5m_input_tokens` and
  `ephemeral_1h_input_tokens`, priced differently (5m ≈ 1.25× input,
  1h ≈ 2× input) — hence the five-tier schema above. If a usage block
  lacks the `cache_creation` breakdown (older logs), fall back to
  pricing all of `cache_creation_input_tokens` at the 5m tier.
- Seed pricing.json with the current Anthropic lineup plus every model ID
  observed in real logs (this machine: `claude-opus-4-8`, `claude-fable-5`).
  Model ID `<synthetic>` appears in logs for locally-generated placeholder
  messages — **skip it in costing entirely** (zero cost, not "unknown").
- **Seeded 2026-07-17** (`src/cost/pricing.json`) with the full current
  lineup: Fable 5 / Mythos 5 ($10/$50), Opus 4.6 to 4.8 ($5/$25), Sonnet 4.6
  and 5 ($3/$15), Haiku 4.5 ($1/$5); cache read is 0.1x input, writes are
  1.25x (5m) and 2x (1h). Rescan of all local logs the same day confirmed
  only `claude-opus-4-8`, `claude-fable-5`, and `<synthetic>` appear.
- **Cache write tier in practice (verified 2026-07-17):** recent Claude Code
  sessions on this machine write cache entries exclusively at the 1h tier
  (the largest local session: 466,744 tokens at 1h, zero at 5m). The 5m
  fallback for missing splits therefore only matters for older logs.
- Aggregators: by session, day, project, model
- **Cross-file dedup is unnecessary (verified 2026-07-17):** message ids do
  not repeat across session files (checked all 41 local sessions, 3,873
  ids), so per-session rollups sum cleanly with no global dedup. Resumed
  conversations get fresh api message ids.
- **Live sessions grow mid-read (verified 2026-07-17):** the active
  session's file is appended between reads, so two measurements moments
  apart legitimately differ. Harmless for aggregation; snapshot comparisons
  must copy the file first. On a frozen copy the parser matches jq exactly.
- Differentiator metrics (beyond basic cost totals):
  - **Cache hit ratio** — cache_read vs total input; the real cost story
  - **Cost per tool category** — attribute assistant-turn cost to the tools it invoked.
    **Attribution rule (implemented 2026-07-18):** a message's cost splits
    evenly across its tool calls; messages with no tool calls land in a
    `chat` bucket; messages on abandoned branches have no surviving events
    so they also land in `chat`. The category sums always equal the total,
    nothing is lost or double counted.
  - **Subagent vs main-thread spend** — via `isSidechain`
  - **Tool stats** — call counts, failure rates per tool
  - **Time** — session duration, turn count, longest gaps

## 4. Transcript renderer (module 3)

### Typography system — four channels, one job each

| Channel | Options | Job |
|---|---|---|
| Color | 16-color default (theme-aware) | **who/what** — speaker & event identity |
| Weight | bold / dim / normal | **importance** — read vs skim |
| Style | italic, underline, inverse, strikethrough | **voice** — special text kinds |
| Space | indent, blank lines, gutter glyphs, rules | **structure** — begin/end/nest |

### Per-event spec

| Event | Treatment |
|---|---|
| User message | **bold + cyan**, `●` gutter, dim timestamp right of marker. Loudest thing on screen — these are the scan anchors. |
| Claude prose | **unstyled default.** Body text is the baseline everything else is relative to. |
| Thinking | dim + italic, collapsed to a `⋮ thinking (N lines)` label (the glyph already signals hidden content); full text only with `--full` |
| Tool call | colored glyph per family (`⚡` bash, `✎` edit/write, `⌕` read/grep, `⛁` web), **description bold**, raw command dim on next line with `└` connector. Path labels truncate from the **front**, keeping the file name (`…/memory/phase-status.md`); prose/commands truncate from the end |
| Tool result | dim, truncated ~3 lines; **errors: red, fully expanded** |
| Cost/meta | dim badges at turn boundaries (`· 1.8k out · $0.04`); inverse-video chips in session header |
| Separation | blank line between turns; dim `─` rule at session boundaries only; 2-space hanging indent so wraps clear the gutter |
| Subagents | indent one level under their Task call |

### Reference mockup (structure must read fine with zero styling)

```
─ session 3ab55ea1 ─  opus-4.8 · $0.42 · 14 turns · 6m

● YOU                                              04:28
  help me set the terminal title automatically

◆ Claude
  I'll check your shell config first.

  ⚡ Check terminal app & shell config          $0.01
     └ echo $TERM_PROGRAM; ls ~/.zshrc …
  ✎ ~/.zshrc  (+3 −0)

  ⋮ thinking (12 lines)

  Done — your terminal now shows the session title.

● YOU                                              04:31
  nice, that worked
```

### Degradation ladder

1. Full: truecolor + italic (feature-detected)
2. Default: 16-color, no italic assumptions
3. `NO_COLOR` / piped: styling stripped, structure carries everything
4. `--ascii`: glyphs swapped for ASCII

### Design principles

- **Dim is the primary tool, not bold.** A transcript is ~80% machinery;
  dimming machinery makes conversation pop without shouting.
- **Every style must survive removal.**
- Wrap at `min(terminal width, 100)`; use a string-width lib for
  unicode/emoji correctness.

## 5. CLI surface (v1 — frozen)

Install: `npx ccprism` (try it), `npm install -g ccprism` (keep it),
`npm uninstall -g ccprism` (gone completely). Also works via `pnpm dlx` / `bunx`.

Trust guarantees: only ever **reads** `~/.claude/projects/`; no network, no
telemetry, no config file, no state; uninstall leaves zero trace.

### Commands

Split by what they are for: **live** commands run beside a session in
progress, **reports** read sessions that already exist. `--help` shows the
same two groups.

```
Live:
ccprism statusline         cost, context, and rate limit panel for statusLine
ccprism watch [id]         tail a session, stream cost as it changes
ccprism view --follow      the transcript, appended live as the session grows

Reports:
ccprism                    dashboard: today / week, per project & model
ccprism sessions           recent sessions: cost, duration, turns, model
ccprism view [id]          transcript (latest session if id omitted)
ccprism doctor             parse health: skipped lines, unknown model IDs
```

Two of those are features rather than commands and so cannot appear in a
grouped command list: the bare `ccprism` dashboard, and `view --follow`. Both
are covered by trailing help text instead.

Commander orders help groups by **first registration**, so the live commands
are declared first in `buildProgram`. Declaration order is load bearing;
moving those blocks reorders the help. A test pins it.

Phase 3 adds `view --markdown`; later, `find <query>`.

#### `statusline`

Built for Claude Code's `statusLine` setting, which runs a command after each
assistant message and pipes session JSON on stdin (schema:
code.claude.com/docs/en/statusline). The anchor field is
`transcript_path` — it names the exact session file, so there is no guessing
by mtime. We parse that file with the normal pipeline and print **ccprism's
own** cost, so the number matches `view` and the dashboard rather than echoing
Claude Code's `cost.total_cost_usd`. Run from a shell with no piped input it
falls back to the newest session, which makes it previewable.

Reading that JSON lives in `parser/host.ts`, not in the command: it is pure
parsing with no cost or style dependency, so it belongs on the parser side of
the one-way arrow. The shape is Claude Code's and it drifts between releases,
so **every field is optional and every read is guarded** — a key that is
missing, null, or the wrong type reads as `undefined` and its part of the
panel does not render. Nothing in that file throws. Only fields we actually
render are parsed; an unrendered field is dead code.

Output is a panel of up to four rows, one job each. Claude Code renders one
row per printed line, in its own block **above** the built-in footer badges
(it does not replace them).

```
sec-review  ·  opus-4-8  ·  high  ·  2 turns        what is running
$0.19  ·  $2.40/hr  ·  $0.03 wasted  ·  +156 −23    what it cost
▓▓▓░░░░░░░░░░░  14%   27.4k / 200k ctx              room left
▓▓▓▓░░░░░░░░░░  24%   5h · 41% week · 89% cache     quota left
```

Every row and every segment drops out when its data is missing, rather than
rendering a zero — so the panel shrinks back to two rows on an API plan with
nothing to report. A row never half exists: no empty gauges, no `$0.00
wasted`, no `+0 −0`. What is absent when:

- `session_name` — only with a `--name`/`/rename` name or a generated title;
  the default `my-app-3f` style name does not populate it. A subagent's
  `agent.name` stands in when the session has none, rather than taking a
  second segment.
- `effort.level` — only when the current model has the parameter.
- `rate_limits` — Claude.ai subscribers only, and only after the first
  response of the session. Each window is independently absent.
- Burn rate — suppressed below a minute of wall clock, where a few cents
  divides out to an alarming and meaningless hourly rate.
- Wasted spend — `offBranch` cost, money paid for output on retried and
  abandoned branches that was never seen. A subset of the total, not spend on
  top of it. Hidden at zero, which is the good news.

The **five-hour** window gets the bar, being the one that cuts a working
session off; the weekly window rides beside it as a number. With no
subscription to report, the cache share takes the bar instead, so the row
still leads with a gauge rather than a lone number.

`ctx` is the input side of the most recent main-thread API call (fresh input +
cache reads + cache writes, output excluded — the same basis as Claude Code's
`used_percentage`). The **token count is ccprism's own** so it agrees with
`view` and the dashboard; only the **window size** is taken from the session
JSON (`context_window.context_window_size`). On a manual run no size is sent,
so one is inferred: context above 200k proves the extended tier, and assuming
the small window there would report a false red 100%. The gauge row drops
entirely before the first API call.

Color rules (this surface inverts two defaults on purpose):

- Color is **on by default**. Statusline stdout is *always* captured, so the
  normal pipe test would strip every color; `colorEnabledWhenCaptured` honors
  only `--no-color` and `NO_COLOR`.
- **`dim` is banned for content here.** It renders as low-contrast gray, and
  this is small text on someone else's background. Dim is kept for separators
  only, which are structure and should recede.
- Gauges shift green → yellow → red at 50% / 80%. This is the one color that
  carries information rather than decoration: it warns before compaction and
  before a cutoff. The token detail inherits the gauge color, being the same
  measurement. Cache hit is **inverted** (green ≥ 80%, red < 50%) — a low
  cache share is the expensive case. Inversion is a separate function rather
  than a flag on the first, because the thresholds are genuinely different
  numbers and not a mirror.
- Model is colored by family (opus magenta, sonnet blue, haiku green, fable
  cyan) so a model switch is visible at a glance. Cost is bold, turns plain.

A statusLine command must never break its host, so once Claude Code has
invoked us every failure path prints best effort and exits 0. Note it runs in
a bare non-interactive shell that may not have a version-managed `node` on
PATH — absolute paths in the `command` avoid a silently blank bar.

Settings snippet:

```json
{ "statusLine": { "type": "command", "command": "ccprism statusline" } }
```

#### `watch`

Tails one session and streams its cost as it changes. An **append log**, not a
redraw-in-place panel: it prints the same one-line format as `statusline`,
stamped with a wall clock, each time the numbers actually move. That keeps it
live in a terminal and still a clean cost log when redirected to a file —
which cursor tricks would not survive. The header (`watching <file> — ctrl-c
to stop`) goes to stderr so a redirect of stdout captures only the cost lines.

```
10:32:15  opus-4-8 · $0.19 · +$0.04 · 27.8k ctx · 2 turns
```

The `+$0.04` is the cost added since the last line printed, sitting next to
the total so a scan down the log reads as both a running total and the price
of each turn. It is omitted on the first line, when a model has no pricing,
and when the change is too small to move the printed total — a `+$0.00` would
read as a bug rather than as free.

The delta forces the tick to render **twice**. Change detection compares the
line *without* the delta; the printed line has it spliced in. Folding the
delta into the compared text would make an unchanged session differ from the
stored line on every tick and print forever. Hence `sessionSnapshot` returns
the summary and the undecorated text rather than one string.

Rate limits deliberately do **not** appear here. `rate_limits` arrives only on
the statusline's stdin JSON; `watch` is a standalone command tailing a file
with no Claude Code process feeding it, and inventing a state file to carry
the number across would break the read-only and no-state constraints.

It follows the session resolved at startup for the whole run: the newest one
with a conversation, or the `[id]` prefix given (same matching as `view`:
ambiguous exits 1, no match exits 2). The file is polled once a second; a
change re-parses the whole file (the streaming reader drops any half-written
trailing line, so a mid-append snapshot is safe) and prints only when the cost
line differs from the last — the clock is excluded from that comparison, so an
unchanged session stays quiet however often the file is touched.

#### `view --follow`

The organized chat, pointed at a session that is still being written. It
renders what exists, then appends turns as they arrive, so a split pane beside
`claude` shows the conversation in the readable form instead of the TUI's.
(Rendering *inside* Claude Code is not possible — it owns its TUI, and
`statusLine` is the only extension point.)

Like `watch`, it is an **append log**: a printed line is final, nothing is ever
redrawn. That constraint decides the whole design, because three things in a
static render mutate after the fact:

- **Unfinished tool calls.** The log is appended in causal order, but a message
  with parallel calls writes both calls before either result, while the
  renderer draws each result under its own call. So each pass emits only the
  *settled* prefix: all turns but the last, plus the last turn's items up to
  the first call still waiting on its result. Earlier turns are settled whole —
  a call interrupted in a finished turn will never resolve, and waiting on it
  would freeze the stream.
- **The turn cost badge.** A turn's cost is not known until the turn ends, so
  the badge moves off the Claude anchor onto a **closing line**, right-aligned
  and dim, printed when the turn settles. A badge on the anchor would sit on
  screen reading `$0.03` for a turn that ends at `$0.40`.
- **The clock and the terminal width.** Both are read once at startup; a
  relative timestamp that ticks would silently rewrite a printed line.

The header follows the same honesty rule: it opens with identity only
(`── session 52e94664 ──  opus-4-8 · live`) and the totals are printed as a
closing line when the stream ends, where they are finally true.

Each pass renders the settled transcript and prints whatever is past the end
of the previous render. That render is *almost* a monotone function of the
log, not quite: the tree resolver extends the branch forward past the leaf,
guessing that the newest sibling wins, and a later `last-prompt` line can name
a leaf on the other side of a fork. When the new render is not an extension of
what is on screen, the honest move is the only one available — say so
(`… transcript changed, lines above are stale`) and print the branch that won.
Measured against a replayed real session this fires on under 5% of passes.

`--json` is not supported with `--follow` yet (exit 2); the natural shape is
NDJSON, one object per settled turn.

### Flags

Global (every command):

| Flag | Behavior |
|---|---|
| `--json` | machine-readable output |
| `--no-color` | strip styling (also triggered by `NO_COLOR` env and pipe detection) |
| `--ascii` | glyphs `●◆⚡✎└` → `* > $ + \_` (CI logs, exotic terminals) |
| `--project <path>` | scope to one project (default: all) |
| `--since <date>` / `--until <date>` | time window for metrics |

`view` only: `--full` (expand raw commands, tool outputs, thinking),
`--markdown` (Phase 3), `--costs` (per-message cost badges), `-f/--follow`
(keep appending turns as the session grows).

`sessions` only: `--limit <n>` (default 20, 0 shows all).

### UX rules

- `-h` output fits one screen. No pager, no walls.
- `view` with no args renders the latest session immediately.
- Unknown model in logs → tokens shown, cost column reads `?`, one dim
  footnote pointing at `doctor`. Never a crash, never a zero passed off as
  a real cost.
- Exit codes: 0 ok, 1 error, 2 no sessions found (scriptable).
- Session IDs accept unambiguous prefixes (`view 3ab5`).

## 6. Explicitly out of scope (v1)

Model rerouting (cut permanently — see CLAUDE.md), LLM calls of any kind,
config files, daemons/alerts, non-Claude-Code log formats, TUI, HTML export
(markdown export is Phase 3; HTML maybe later).
