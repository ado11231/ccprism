import { Command } from "commander";
import { version } from "../package.json";
import { runDashboard } from "./commands/dashboard.js";
import { runDoctor } from "./commands/doctor.js";
import { runSessions } from "./commands/sessions.js";
import { runView } from "./commands/view.js";
import type { CommandFlags } from "./commands/load.js";

interface RawOpts {
  json?: boolean;
  color?: boolean;
  ascii?: boolean;
  project?: string;
  since?: string;
  until?: string;
  limit?: string;
  full?: boolean;
  costs?: boolean;
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

  withGlobalFlags(
    program.command("sessions"),
  )
    .description("List recent sessions with cost, duration, turns, and model")
    .option("--limit <n>", "rows to show, 0 for all", "20")
    .action(async (_opts: RawOpts, command: Command) => {
      const opts = command.optsWithGlobals() as RawOpts;
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 0) {
        console.error(`invalid --limit: ${opts.limit}`);
        process.exitCode = 1;
        return;
      }
      process.exitCode = await runSessions({ ...toFlags(opts), limit });
    });

  withGlobalFlags(program.command("view"))
    .description("Render a session transcript, latest session if id omitted")
    .argument("[id]", "session id, unambiguous prefixes accepted")
    .option("--full", "expand raw commands, tool outputs, and thinking")
    .option("--costs", "per call cost badges on tool lines")
    .action(async (id: string | undefined, _opts: RawOpts, command: Command) => {
      const opts = command.optsWithGlobals() as RawOpts;
      process.exitCode = await runView({
        ...toFlags(opts),
        id,
        full: opts.full === true,
        costs: opts.costs === true,
        ascii: opts.ascii === true,
      });
    });

  withGlobalFlags(program.command("doctor"))
    .description("Report parse health: skipped lines and unknown model ids")
    .action(async (_opts: RawOpts, command: Command) => {
      process.exitCode = await runDoctor(
        toFlags(command.optsWithGlobals() as RawOpts),
      );
    });

  // Running ccprism with no command shows the dashboard.
  withGlobalFlags(program).action(async (opts: RawOpts) => {
    process.exitCode = await runDashboard(toFlags(opts));
  });

  return program;
}
