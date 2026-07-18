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

## Backlog (ordered)

1. `find "query"` — search across all sessions with pretty result context
2. "Suggested model" insights (the observability-flavored ghost of the cut
   reroute feature)
3. HTML export
4. Config file (only once flags demonstrably aren't enough)

## Standing rule

When Anthropic ships a new model, add its pricing the same day — cost
reporting for that model is broken until `pricing.json` updates. Keep
`pricing.json` a single obvious file so these updates stay trivial PRs.
