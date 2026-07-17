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
- Aggregators: by session, day, project, model
- Differentiator metrics (beyond basic cost totals):
  - **Cache hit ratio** — cache_read vs total input; the real cost story
  - **Cost per tool category** — attribute assistant-turn cost to the tools it invoked
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
| Thinking | dim + italic, collapsed to first line + `(… N lines)` |
| Tool call | colored glyph per family (`⚡` bash, `✎` edit/write, `⌕` read/grep, `⛁` web), **description bold**, raw command dim on next line with `└` connector |
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

  ⋮ thinking (… 12 lines)

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

```
ccprism                    dashboard: today / week, per project & model
ccprism sessions           recent sessions: cost, duration, turns, model
ccprism view [id]          transcript (latest session if id omitted)
ccprism doctor             parse health: skipped lines, unknown model IDs
```

Phase 3 adds `view --markdown`, `statusline`, `watch`; later, `find <query>`.

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
`--markdown` (Phase 3), `--costs` (per-message cost badges).

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
