# Roadmap

Each phase ships something usable on its own.

## Phase 0 — Foundation

- Scaffold: TypeScript strict (Node >= 20), tsup, commander, vitest, `bin`
  entry (npx-runnable), GitHub Actions CI (vitest + tsc on every PR)
- Parser module: streaming JSONL reader, `parentUuid` tree → active branch via
  `leafUuid`, typed event stream, sidechain grouping, **usage dedup by
  `message.id`** (multi-line assistant responses repeat identical usage)
- Scrub script (checked in): replaces message text/paths/outputs with
  same-shape placeholders, preserves UUIDs, tree structure, usage numbers —
  so any real session can safely become a fixture
- Fixtures from real sessions (scrubbed via script), unit tests
- **Done when:** parser turns any local session into a clean event array,
  tests green.

## Phase 1 — Metrics (done 2026-07-18)

- `pricing.json` + five-tier cost function (unknown models degrade gracefully;
  cache writes split 5m/1h per design.md)
- Aggregators: session / day / project / model
- Commands: `ccprism` (dashboard), `ccprism sessions`
- Differentiator metrics: cache hit ratio, cost per tool category, subagent
  split, tool call/failure stats, time metrics (duration, turns, gaps)
- `doctor` command (parse health: skipped lines, unknown models)
- `--json` everywhere
- **Done when:** numbers match a manual spot-check against one real session.
  Checked 2026-07-18 against the test project session (52e94664): cost,
  every token tier, message count, tool calls, and duration matched a jq
  cross check exactly. The flat count said 7 turns where ccprism said 6,
  and the extra line was a duplicated prompt on an abandoned branch, so
  the tree aware number is the correct one.
- *Already a usable tool at this point.*
- Deferred to the polish pass: interruption notices ("[Request interrupted
  by user]") currently count as turns; decide whether they should.

## Phase 2 — Transcript viewer

- `view [id]` (defaults to latest), `--full`
- Full typography spec from design.md: gutter glyphs, bold descriptions over
  dimmed commands, dim/italic thinking, red expanded errors, cost badges
- Degradation ladder: 16-color default, `NO_COLOR`, pipe detection, `--ascii`
- **Done when:** a stranger can read a session and follow what happened
  without expanding anything.

## Phase 3 — Polish

- `view --markdown` — shareable transcript export (gists, PRs, docs)
- `statusline` — one-line current-session cost/tokens for Claude Code's
  custom statusline
- `watch` — tail the active session, stream cost live
- Help text that fits one screen; `view` with no args renders instantly
- npm publish (MIT license)
- **Done when:** published, statusline works in your own daily setup.

## Plugin plan (spec of 2026-07-21)

Everything above stays. This is what comes next, and it supersedes the
unshipped parts of Phase 3. The goal: keep the live terminal and the metrics
as the core, tighten the command surface, and ship a Claude Code plugin layer
so the whole thing lives inside a running `claude` session, with the report
commands on the side. One binary, four integration surfaces.

### P1. CLI surface cleanup (in progress)

- `watch` merges into `view --follow --compact`. The old command stays as a
  hidden alias that forwards and prints a deprecation note on stderr. Its
  snapshot logic moves into a shared `turnDelta` helper in `cost/aggregate.ts`,
  which the Stop hook in P3 needs too.
- `sessions` gains `--sort cost|duration|turns|time`, `--model <substring>`,
  and `--grep <text>` over user prompt text. A matched session shows a dim
  snippet of the matching prompt under its row, so `sessions --grep` answers
  "which session did I fix X in" and `view <id>` opens it.
- `view` gains `--export md` and `--export html`, writing to `./<shortid>.md`
  unless `-o` says otherwise. Export implies `--full`. The html is one file,
  no scripts and no external assets.
- The dashboard gains a per day row for the last 14 days with a small bar, and
  a `--month` flag that widens today and this week to this month.
- `statusline` reads `COLUMNS` and drops the rightmost fields per row at
  narrow widths instead of wrapping.
- `doctor` is unchanged.
- **Done when:** the help fits one screen, the merged follow modes behave the
  same as the commands they replace, and the new flags have tests.

### P2. `ccprism context [id]`

Answers "what is filling the context window right now". Attributes active
branch tokens by origin: prompt overhead, file reads grouped per path, tool
output by category, and conversation. Shows the window fill, then the top ten
consumers with tokens, share of the window, and a bar. Files read more than
once are flagged. Where the log only gives text, the count is estimated and
marked with `~`, never presented as exact. `--json` and an optional `--watch`.
`view --follow` picks up a one line context summary when fill crosses 50, 80,
and 90 percent.

This is the feature that makes people pick ccprism over a pure cost reporter.

### P3. Hooks

A hidden `ccprism hook <event>` reads the hook JSON on stdin, resolves the
session through `transcript_path`, and dispatches per event: Stop prints the
turn cost delta and the new fill, plus a warning naming the top three
consumers when fill crosses a threshold; PostToolUse warns when a result added
more tokens than the threshold; SessionEnd prints a receipt. Every failure
path prints nothing and exits 0, the same rule the statusline follows.

Config without a config file: `CCPRISM_WARN_TOOL_TOKENS`,
`CCPRISM_WARN_CONTEXT` (default `80,90`), and `CCPRISM_HOOKS=off`. Threshold
warnings fire once per session by comparing the previous fill read back from
the transcript, never by writing state.

Read the hooks reference at code.claude.com/docs/en/hooks before building
this. The JSON schemas and the visible output channel per event are not
things to guess.

### P4. Slash commands, packaging, install

`/prism`, `/prism:context`, `/prism:last`, and `/prism:session` as thin
wrappers that run the CLI with `--no-color`. A `plugin/` directory in the repo
holds the manifest, hook registrations, command files, and the statusline
entry, so it installs as one plugin. For people not using plugins,
`ccprism install` and `ccprism uninstall` write and remove the same entries in
`~/.claude`, printing every path they touch.

This amends the read only promise, on purpose: ccprism never writes outside
its install unless you run `ccprism install`.

### P5. MCP server (optional, last)

`ccprism mcp`, a stdio server exposing read only `get_session_cost`,
`get_context_breakdown`, `get_wasted_spend`, and `search_sessions(query)`, so
Claude itself can notice that context is mostly stale file reads and act on
it. Only after P1 through P4 are stable.

## Statusline metric backlog

Candidates for the live panel, and where the data comes from. Rows are the
scarce resource (see design.md §5) — this is a curation problem, not a
capacity one, so additions have to earn their row.

**Shipped 2026-07-21** — the panel went from two rows to four, one job each
(identity / cost / context / limits): rate limit gauge (`five_hour` on the
bar, `seven_day` beside it), lines changed, effort and fast-mode badges,
session and agent name, cache hit ratio, wasted spend, burn rate. `watch`
gained the per-turn cost delta. Every field is optional, so the panel shrinks
back to two rows on an API plan.

**Still free on the stdin JSON, unused:**

| Metric | Field | Notes |
|---|---|---|
| Session / API duration | `cost.total_duration_ms`, `total_api_duration_ms` | ratio = how much was spent waiting |
| Rate limit reset | `rate_limits.*.resets_at` | "24% and resets in 2h" reads very differently from "24% and resets in 4 days". Deferred only because the limits row is full |
| Thinking | `thinking.enabled` | did not earn a badge next to effort |
| Git + PR | `workspace.repo.name`, `git_worktree`, `pr.number`, `pr.review_state` | |

**ccprism-only — from our own parse, and the actual differentiator:**

| Metric | Notes |
|---|---|
| Tool failure rate | gauge-shaped (% of calls that failed) |
| Cost split by tool | bash vs edit vs read. Shipped in `watch -v` shape? Not yet — no row for it |
| Subagent spend | how much went to Task sidechains |
| Longest gap | duration overstates real work without it |

Of the gauge-shaped four (natural 0–100% ceiling), three are shipped: context
fill, rate limits, cache hit. Only tool failure rate is left. Everything else
reads better as a plain number — a bar with no ceiling is decoration.

Standing rule for this panel: **don't duplicate what Claude Code's own footer
already shows.** Both are visible at once, so a repeated metric spends screen
space twice.

`watch` cannot show rate limits at all: `rate_limits` exists only on the
statusline's stdin JSON, and `watch` tails a file with no host process feeding
it. Carrying the number across would need a state file, which the read-only
and no-state constraints rule out.

## Backlog (ordered)

Three of these were absorbed by the plugin plan above: `view --follow`
shipped 2026-07-20, cross session search became `sessions --grep` in P1, and
HTML export became `view --export html` in P1. What is left:

1. "Suggested model" insights (the observability-flavored ghost of the cut
   reroute feature)
2. Tool failure rate on the statusline, the last gauge shaped metric
3. NDJSON for `view --follow --json`, which currently exits 2
4. Config file (only once flags demonstrably aren't enough)

## Standing rule

When Anthropic ships a new model, add its pricing the same day — cost
reporting for that model is broken until `pricing.json` updates. Keep
`pricing.json` a single obvious file so these updates stay trivial PRs.
