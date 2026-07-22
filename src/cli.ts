import { Command, Option } from "commander";
import { version } from "../package.json";
import { runDashboard } from "./commands/dashboard.js";
import { runDoctor } from "./commands/doctor.js";
import {
  runSessions,
  SESSION_SORTS,
  type SessionSort,
} from "./commands/sessions.js";
import { runStatusline } from "./commands/statusline.js";
import {
  runView,
  EXPORT_FORMATS,
  type ExportFormat,
} from "./commands/view.js";
import type { CommandFlags } from "./commands/load.js";

// Help group headings. Live commands run beside a session in
// progress; reports read sessions that already exist. The trailing
// colon is commander's convention for a heading.
const LIVE = "Live:";
const REPORTS = "Reports:";

interface RawOpts {
  json?: boolean;
  color?: boolean;
  ascii?: boolean;
  project?: string;
  since?: string;
  until?: string;
  limit?: string;
  sort?: SessionSort;
  model?: string;
  grep?: string;
  full?: boolean;
  costs?: boolean;
  follow?: boolean;
  compact?: boolean;
  export?: ExportFormat;
  output?: string;
}

function toFlags(opts: RawOpts): CommandFlags {
  return {
    json: opts.json === true,
    color: opts.color !== false,
    project: opts.project,
    since: opts.since,
    until: opts.until,
  };
}

// The flags every command accepts. Commander scopes options to one
// command, so each command registers its own copy.
function withGlobalFlags(command: Command): Command {
  return command
    .option("--json", "machine readable output")
    .option("--no-color", "plain output, also implied by NO_COLOR or piping")
    .option("--ascii", "swap unicode glyphs for ascii")
    .option("--project <path>", "only sessions from this project directory")
    .option("--since <date>", "window start, YYYY-MM-DD or an ISO timestamp")
    .option("--until <date>", "window end, inclusive");
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("ccprism")
    .description(
      "Token metrics and readable transcripts for Claude Code sessions",
    )
    .version(version);

  // Commands are grouped in --help by what they are for: the ones you
  // run beside a session in progress, and the ones you run over
  // sessions that already exist. Commander orders the groups by first
  // registration, so the live commands are declared first to put them
  // at the top. Moving these blocks reorders the help.
  withGlobalFlags(program.command("statusline"))
    .helpGroup(LIVE)
    .description(
      "Cost, context, and rate limit panel for Claude Code's custom statusLine",
    )
    .action(async (_opts: RawOpts, command: Command) => {
      const opts = command.optsWithGlobals() as RawOpts;
      process.exitCode = await runStatusline({
        ...toFlags(opts),
        ascii: opts.ascii === true,
      });
    });

  withGlobalFlags(
    program.command("sessions"),
  )
    .helpGroup(REPORTS)
    .description("List recent sessions with cost, duration, turns, and model")
    .option("--limit <n>", "rows to show, 0 for all", "20")
    .addOption(
      new Option("--sort <field>", "order the rows, biggest first")
        .choices([...SESSION_SORTS])
        .default("time"),
    )
    .option("--model <text>", "only sessions that used a matching model")
    .option("--grep <text>", "only sessions with a prompt containing this text")
    .action(async (_opts: RawOpts, command: Command) => {
      const opts = command.optsWithGlobals() as RawOpts;
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 0) {
        console.error(`invalid --limit: ${opts.limit}`);
        process.exitCode = 1;
        return;
      }
      process.exitCode = await runSessions({
        ...toFlags(opts),
        limit,
        sort: opts.sort ?? "time",
        model: opts.model,
        grep: opts.grep,
      });
    });

  withGlobalFlags(program.command("view"))
    .helpGroup(REPORTS)
    .description("Render a session transcript, latest session if id omitted")
    .argument("[id]", "session id, unambiguous prefixes accepted")
    .option("--full", "expand raw commands, tool outputs, and thinking")
    // Declared so --export can expand by default and still be told
    // not to. With both forms registered, neither one given leaves the
    // value unset, which is what tells them apart.
    .option("--no-full", "keep the compact render when exporting")
    .option("--costs", "per call cost badges on tool lines")
    .option("-f, --follow", "keep appending turns as the session grows")
    .option("--compact", "with --follow, a cost log instead of the transcript")
    .addOption(
      new Option("--export <format>", "write the transcript to a file").choices([
        ...EXPORT_FORMATS,
      ]),
    )
    .option("-o, --output <path>", "where --export writes, default ./<id>.<format>")
    .action(async (id: string | undefined, _opts: RawOpts, command: Command) => {
      const opts = command.optsWithGlobals() as RawOpts;
      const exportAs = opts.export;
      process.exitCode = await runView({
        ...toFlags(opts),
        id,
        // An export is meant to be read on its own later, with nobody
        // around to rerun it with --full, so it expands unless asked
        // not to.
        full: opts.full ?? exportAs !== undefined,
        costs: opts.costs === true,
        ascii: opts.ascii === true,
        follow: opts.follow === true,
        compact: opts.compact === true,
        exportAs,
        out: opts.output,
      });
    });

  withGlobalFlags(program.command("doctor"))
    .helpGroup(REPORTS)
    .description("Report parse health: skipped lines and unknown model ids")
    .action(async (_opts: RawOpts, command: Command) => {
      process.exitCode = await runDoctor(
        toFlags(command.optsWithGlobals() as RawOpts),
      );
    });

  // watch became a mode of view. It is kept as a hidden forwarder so
  // muscle memory and any scripts still work, and it says once on
  // stderr what to type instead. Registered last and hidden, so it is
  // out of --help and out of the way of the group ordering above.
  const watch = withGlobalFlags(new Command("watch"))
    .description("deprecated, now view --follow --compact")
    .argument("[id]", "session id, unambiguous prefixes accepted")
    .action(async (id: string | undefined, _opts: RawOpts, command: Command) => {
      console.error("ccprism watch is now ccprism view --follow --compact");
      const opts = command.optsWithGlobals() as RawOpts;
      process.exitCode = await runView({
        ...toFlags(opts),
        id,
        full: false,
        costs: false,
        ascii: opts.ascii === true,
        follow: true,
        compact: true,
        exportAs: undefined,
        out: undefined,
      });
    });
  program.addCommand(watch, { hidden: true });

  // Running ccprism with no command shows the dashboard.
  withGlobalFlags(program).action(async (opts: RawOpts) => {
    process.exitCode = await runDashboard(toFlags(opts));
  });

  // The two features that are not commands, so the grouped list above
  // cannot mention them: the bare dashboard and view's live mode.
  program.addHelpText(
    "after",
    [
      "",
      "Run with no command for the dashboard: today and this week, by",
      "project and model.",
      "",
      "view --follow is the live form of view. It renders the session so",
      "far, then appends turns as they arrive. Add --compact for a cost",
      "log instead: one timestamped line each time the numbers move.",
    ].join("\n"),
  );

  return program;
}
