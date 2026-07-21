# ccprism

A local CLI that shows where your Claude Code tokens went and renders any
session as a readable transcript in your terminal.

Claude Code keeps a log file for every session. ccprism reads those logs and
turns them into two things:

1. Metrics. Token and cost breakdowns per session, day, project, and model.
2. Transcripts. Any session rendered as a clean, color coded conversation
   you can actually read.

## Guarantees

ccprism only ever reads the logs in `~/.claude/projects`. It never writes
outside its own install, so uninstalling removes every trace. It makes no
network calls and collects no telemetry. Costs come from a local pricing
table. There is no config file, no state, and no background process.

## Install

```bash
npx ccprism
```

or keep it around:

```bash
npm install -g ccprism
```

## Commands

There are two ways to use ccprism: beside a session that is running, and over
sessions that have already happened.

**Live** — watch a session as it costs you money.

```
ccprism statusline     cost, context, and rate limit panel for Claude Code
ccprism watch [id]     one timestamped line each time the cost changes
ccprism view --follow  the transcript, appended live as the session grows
```

**Reports** — read what already happened.

```
ccprism                dashboard for today and this week, by project and model
ccprism sessions       recent sessions with cost, duration, turns, and model
ccprism view [id]      render a session transcript, latest session if id omitted
ccprism doctor         parse health: skipped lines and unknown model ids
```

Every command supports `--json` for machine readable output. Color is
stripped automatically when output is piped or when `NO_COLOR` is set.

## Live

### Statusline

`ccprism statusline` prints a panel for Claude Code's custom statusLine, using
ccprism's own cost so the number matches `view` and the dashboard:

```
sec-review  ·  opus-4-8  ·  high  ·  2 turns
$0.19  ·  $2.40/hr  ·  $0.03 wasted  ·  +156 −23
▓▓▓░░░░░░░░░░░  14%   27.4k / 200k ctx
▓▓▓▓░░░░░░░░░░  24%   5h · 41% week · 89% cache
```

Four rows, one job each: what is running, what it cost, how much context is
left, how much quota is left. Two of those numbers are not available anywhere
else — **wasted** is money spent on retried and abandoned branches, output you
paid for and never saw, and the **cache** share is the quiet difference
between a cheap session and an expensive one.

Every row and every field disappears when its data is missing, rather than
showing a zero, so the panel shrinks to two rows when there is nothing to say.
Rate limits need a Pro or Max subscription; on an API plan the cache share
takes the gauge instead. The context and rate gauges turn yellow then red as
they fill; the cache gauge is the other way round, since a low cache share is
the expensive case.

Point Claude Code at it in `~/.claude/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "ccprism statusline" } }
```

A statusLine runs in a bare non-interactive shell that may not have a version
managed `node` on its PATH. If the bar comes up blank, use absolute paths.

### Watch

`ccprism watch` tails one session and prints a line each time the numbers
actually move:

```
10:32:15  opus-4-8 · $0.19 · +$0.04 · 27.8k ctx · 2 turns
10:33:41  opus-4-8 · $0.26 · +$0.07 · 41.2k ctx · 3 turns
```

The `+$0.04` is what the last turn cost, so one log reads as both a running
total and a per turn price. It is an append log rather than a panel that
redraws, which keeps it honest when you redirect it to a file. The header goes
to stderr, so `ccprism watch > costs.log` captures only the cost lines.

### Following a live session

`ccprism view --follow` renders the session so far and then keeps appending
turns as they arrive, which makes a readable split pane beside `claude`:

```bash
ccprism view --follow
```

It never redraws a printed line. Turns appear once they settle, each closed by
a dim right-aligned cost, and the session totals print when you stop it with
ctrl-c. `--json` is not supported with `--follow` yet.

## Reports

### Dashboard

`ccprism` with no command answers where the money went:

```
ccprism · 44 sessions · $578.54 · cache hit 98.8%

  today        $3.33     92 in  37.0k out  3.2M cached
  this week  $346.80  12.3k in   1.9M out  425M cached

  project               sessions     cost
  JrnymanApp                  20  $336.31
  ccprism                      9  $114.31
```

Narrow it with `--project <path>`, `--since`, and `--until`.

### Sessions

`ccprism sessions` lists recent sessions, newest first:

```
id        when      dur  turns    cost  project     model
434033a6  12:20     44m      2   $5.77  ccprism     opus-4-8
a2c633a5  Jul 20    37m      2   $5.02  ccprism     opus-4-8
```

The short id in the first column is what `view` and `watch` take. Any
unambiguous prefix works.

### View

`ccprism view [id]` renders a session as a readable conversation, defaulting
to the most recent one. `--full` expands raw commands, tool output, and
thinking; `--costs` adds a per call cost badge to each tool line.

### Doctor

`ccprism doctor` reports parse health: lines it could not read and model ids
it has no pricing for.

```
ccprism doctor · 44 sessions · 20,990 lines read

  all clean, every line parsed and priced
```

Claude Code's log format drifts between releases. Unknown models still have
their tokens counted, with the cost marked unknown rather than guessed, so
this is where to look if a number seems off.

## Status

Early development. Not yet published to npm.

## License

MIT
