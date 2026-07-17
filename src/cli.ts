import { Command } from "commander";
import { version } from "../package.json";

function notImplemented(name: string): void {
  console.log(`${name}: not implemented yet`);
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("ccprism")
    .description(
      "Token metrics and readable transcripts for Claude Code sessions",
    )
    .version(version);

  program
    .command("sessions")
    .description("List recent sessions with cost, duration, turns, and model")
    .action(() => notImplemented("sessions"));

  program
    .command("view")
    .description("Render a session transcript, latest session if id omitted")
    .argument("[id]", "session id, unambiguous prefixes accepted")
    .action(() => notImplemented("view"));

  program
    .command("doctor")
    .description("Report parse health: skipped lines and unknown model ids")
    .action(() => notImplemented("doctor"));

  // Running ccprism with no command shows the dashboard.
  program.action(() => notImplemented("dashboard"));

  return program;
}
