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

```
ccprism            dashboard for today and this week, per project and model
ccprism sessions   recent sessions with cost, duration, turns, and model
ccprism view [id]  render a session transcript, latest session if id omitted
ccprism statusline one line of cost, context, and turns for the active session
ccprism doctor     parse health: skipped lines and unknown model ids
```

Every command supports `--json` for machine readable output. Color is
stripped automatically when output is piped or when `NO_COLOR` is set.

### Statusline

`ccprism statusline` prints a single line for Claude Code's custom statusLine,
showing ccprism's own cost for the live session next to its context fill and
turn count. Point Claude Code at it in `~/.claude/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "ccprism statusline" } }
```

## Status

Early development. Not yet published to npm.

## License

MIT
