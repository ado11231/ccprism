import { basename, dirname } from "node:path";
import { summarizeSession, type SessionSummary } from "../cost/aggregate.js";
import {
  defaultProjectsRoot,
  discoverSessionFiles,
} from "../parser/discover.js";
import type { ExtractedSession } from "../parser/events.js";
import { parseSessionFile } from "../parser/session.js";
import { fmtTokens, fmtUsd, shortModel } from "../render/format.js";
import type { CommandFlags } from "./load.js";

// One readable line for Claude Code's custom statusLine command:
// ccprism's own cost, the live context fill, and turns for the active
// session. Claude Code pipes session JSON on stdin (see the schema at
// code.claude.com/docs/en/statusline); the key field is
// transcript_path, which names the exact session file so we never
// have to guess by mtime. Run without stdin (straight from a shell)
// it falls back to the newest session, which makes it previewable.
//
// A statusLine command must never break its host, so every failure
// path when invoked by Claude Code prints best effort and exits 0.

export interface StatuslineInput {
  // Raw JSON Claude Code piped in, or undefined when run from a shell
  // with no piped input. Injected so the resolution logic stays
  // testable without touching process.stdin.
  stdin: string | undefined;
}

interface StdinData {
  transcriptPath: string | undefined;
}

// The live context window fill and the model behind it, taken from
// the most recent api call on the main thread. Matches Claude Code's
// own used_percentage, which counts the input side only (fresh input
// plus cache reads plus cache writes), not output.
export interface CurrentContext {
  tokens: number;
  model: string | undefined;
}

export function currentContext(session: ExtractedSession): CurrentContext {
  let latest: (typeof session.usage)[number] | undefined;
  for (const entry of session.usage) {
    if (entry.isSidechain || !entry.onActiveBranch) continue;
    latest = entry;
  }
  if (latest === undefined) return { tokens: 0, model: undefined };
  const u = latest.usage;
  return {
    tokens: u.input + u.cacheRead + u.cacheCreationTotal,
    model: latest.model,
  };
}

// The line itself, kept pure so tests do not need files or stdin.
export function statuslineText(
  summary: SessionSummary,
  context: CurrentContext,
): string {
  const model = context.model ?? summary.models[summary.models.length - 1];
  const cost =
    summary.total.unknownModels.length > 0
      ? "$?"
      : fmtUsd(summary.total.usd);
  const segments = [
    model === undefined ? undefined : shortModel(model),
    cost,
    context.tokens > 0 ? `${fmtTokens(context.tokens)} ctx` : undefined,
    `${summary.turns} ${summary.turns === 1 ? "turn" : "turns"}`,
  ].filter((seg): seg is string => seg !== undefined);
  return segments.join(" · ");
}

function parseStdin(raw: string | undefined): StdinData {
  if (raw === undefined) return { transcriptPath: undefined };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { transcriptPath: undefined };
  }
  const obj =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const path = obj.transcript_path;
  return {
    transcriptPath: typeof path === "string" && path !== "" ? path : undefined,
  };
}

// Reads all of stdin, but only when something is actually piped in.
// A tty means the command was run by hand, so there is nothing to
// read and blocking on it would hang.
async function readStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text === "" ? undefined : text;
}

async function newestSessionPath(root: string): Promise<string | undefined> {
  const files = await discoverSessionFiles(root);
  for (const file of files) {
    // Skip stub files that hold only bookkeeping, same as view's
    // latest default: the newest file is often one.
    const parsed = await parseSessionFile(file.filePath);
    if (parsed.session.events.length > 0) return file.filePath;
  }
  return undefined;
}

export async function runStatusline(
  flags: CommandFlags,
  input?: StatuslineInput,
): Promise<number> {
  const raw = input === undefined ? await readStdin() : input.stdin;
  // Claude Code piped us JSON. Any failure from here on must stay
  // quiet and exit 0 so the user's status line never shows an error.
  const invoked = raw !== undefined;
  const { transcriptPath } = parseStdin(raw);

  const root = flags.root ?? defaultProjectsRoot();
  const filePath = transcriptPath ?? (await newestSessionPath(root));
  if (filePath === undefined) {
    if (!invoked) {
      console.error("no sessions found");
      return 2;
    }
    return 0;
  }

  let parsed;
  try {
    parsed = await parseSessionFile(filePath);
  } catch {
    // A transcript_path that does not resolve is not our problem to
    // surface; print nothing rather than break the bar.
    return invoked ? 0 : 2;
  }

  const summary = summarizeSession(
    {
      filePath,
      projectSlug: basename(dirname(filePath)),
    },
    parsed.session,
  );
  const context = currentContext(parsed.session);

  if (flags.json) {
    console.log(
      JSON.stringify({
        sessionId: summary.sessionId,
        model: context.model ?? summary.models[summary.models.length - 1],
        usd: summary.total.unknownModels.length > 0 ? null : summary.total.usd,
        contextTokens: context.tokens,
        turns: summary.turns,
        source: transcriptPath !== undefined ? "stdin" : "latest",
      }),
    );
    return 0;
  }

  console.log(statuslineText(summary, context));
  return 0;
}
