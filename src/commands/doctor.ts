import { shortId } from "../render/format.js";
import { colorEnabled, makeStyle } from "../render/style.js";
import { loadSessions, type CommandFlags, type LoadedSession } from "./load.js";

interface SessionIssues {
  sessionId: string | undefined;
  projectSlug: string;
  issues: string[];
}

function issuesOf(session: LoadedSession): string[] {
  const issues: string[] = [];
  const read = session.readStats;
  const tree = session.treeStats;

  if (read.malformedLines > 0) {
    issues.push(`${read.malformedLines} malformed lines skipped`);
  }
  const unknownTypes = Object.entries(read.unknownTypes);
  if (unknownTypes.length > 0) {
    const listed = unknownTypes.map(([type, n]) => `${type} x${n}`).join(", ");
    issues.push(`unknown line types: ${listed}`);
  }
  if (session.unknownBlocks > 0) {
    issues.push(`${session.unknownBlocks} unknown content blocks`);
  }
  // Stub files holding only ignorable metadata lines have no tree at
  // all. That is an empty session, not a parse problem.
  if (tree.leafSource !== "last-prompt" && read.keptLines > 0) {
    issues.push(`active branch found via ${tree.leafSource} fallback`);
  }
  if (tree.missingParents > 0) {
    issues.push(`${tree.missingParents} missing parent links`);
  }
  const unknownModels = session.summary.total.unknownModels;
  if (unknownModels.length > 0) {
    issues.push(`models without pricing: ${unknownModels.join(", ")}`);
  }
  return issues;
}

export async function runDoctor(flags: CommandFlags): Promise<number> {
  const sessions = await loadSessions(flags);
  if (sessions.length === 0) {
    console.error("no sessions found");
    return 2;
  }

  let totalLines = 0;
  let malformed = 0;
  const unknownTypes: Record<string, number> = {};
  const unknownModels = new Set<string>();
  const flagged: SessionIssues[] = [];

  for (const session of sessions) {
    totalLines += session.readStats.totalLines;
    malformed += session.readStats.malformedLines;
    for (const [type, n] of Object.entries(session.readStats.unknownTypes)) {
      unknownTypes[type] = (unknownTypes[type] ?? 0) + n;
    }
    for (const model of session.summary.total.unknownModels) {
      unknownModels.add(model);
    }
    const issues = issuesOf(session);
    if (issues.length > 0) {
      flagged.push({
        sessionId: session.summary.sessionId,
        projectSlug: session.summary.projectSlug,
        issues,
      });
    }
  }

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          sessions: sessions.length,
          totalLines,
          malformedLines: malformed,
          unknownLineTypes: unknownTypes,
          modelsWithoutPricing: [...unknownModels],
          flaggedSessions: flagged,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const c = makeStyle(colorEnabled(flags.color));
  const lines: string[] = [];
  lines.push(
    `${c.bold("ccprism doctor")} ${c.dim("·")} ${sessions.length} sessions ` +
      `${c.dim("·")} ${totalLines.toLocaleString()} lines read`,
  );
  lines.push("");

  if (flagged.length === 0) {
    lines.push(`  ${c.green("all clean")}, every line parsed and priced`);
  } else {
    for (const session of flagged) {
      lines.push(`  ${c.bold(shortId(session.sessionId))}  ${c.dim(session.projectSlug)}`);
      for (const issue of session.issues) {
        lines.push(`    ${c.yellow("!")} ${issue}`);
      }
    }
  }

  console.log(lines.join("\n"));
  return 0;
}
