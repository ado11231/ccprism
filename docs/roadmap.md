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

**Free — already on the stdin JSON, currently ignored:**

| Metric | Field | Notes |
|---|---|---|
| **Rate limit gauge** | `rate_limits.five_hour` / `.seven_day` (`used_percentage`, `resets_at`) | **Highest value.** Answers "how much quota before I'm cut off", which nothing else on screen shows. Naturally gauge-shaped. Pro/Max only |
| Lines changed | `cost.total_lines_added` / `_removed` | compact `+156 −23` |
| Session / API duration | `cost.total_duration_ms`, `total_api_duration_ms` | ratio = how much was spent waiting |
| Effort, fast mode, thinking | `effort.level`, `fast_mode`, `thinking.enabled` | |
| Git + PR | `workspace.repo.name`, `git_worktree`, `pr.number`, `pr.review_state` | |
| Session / agent name | `session_name`, `agent.name` | |

**ccprism-only — from our own parse, and the actual differentiator:**

| Metric | Notes |
|---|---|
| **Cache hit ratio** | Gauge-shaped, and *inverted*: low cache = burning money. The most ccprism metric there is |
| **Wasted spend** | Cost on abandoned/retry branches (`offBranch`) — money paid for output never seen. Novel |
| Burn rate | $/hour for the session |
| Tool failure rate | gauge-shaped (% of calls that failed) |
| Cost split by tool | bash vs edit vs read |
| Subagent spend | how much went to Task sidechains |
| Longest gap | duration overstates real work without it |

Only four of these are genuinely gauge-shaped (natural 0–100% ceiling):
context fill (shipped), rate limits, cache hit ratio, tool failure rate. The
rest read better as plain numbers — a bar with no ceiling is decoration.

Standing rule for this panel: **don't duplicate what Claude Code's own footer
already shows.** Both are visible at once, so a repeated metric spends screen
space twice.

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
