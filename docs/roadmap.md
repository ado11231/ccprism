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

1. `view --follow` — the organized transcript tailing the live session, for a
   split pane beside `claude` (Claude Code owns its TUI; `statusLine` is the
   only in-window extension point, so side-by-side is the answer)
2. `find "query"` — search across all sessions with pretty result context
3. "Suggested model" insights (the observability-flavored ghost of the cut
   reroute feature)
4. HTML export
5. Config file (only once flags demonstrably aren't enough)

## Standing rule

When Anthropic ships a new model, add its pricing the same day — cost
reporting for that model is broken until `pricing.json` updates. Keep
`pricing.json` a single obvious file so these updates stay trivial PRs.
