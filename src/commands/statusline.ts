import { basename, dirname } from "node:path";
import { summarizeSession } from "../cost/aggregate.js";
import { parseSessionFile } from "../parser/session.js";
import { currentContext, statuslinePanel } from "../render/live.js";
import { glyphsFor } from "../render/glyphs.js";
import { colorEnabledWhenCaptured, makeStyle } from "../render/style.js";
import { defaultProjectsRoot } from "../parser/discover.js";
import { newestSessionPath, type CommandFlags } from "./load.js";

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

export interface StatuslineFlags extends CommandFlags {
  ascii: boolean;
}

export interface StatuslineInput {
  // Raw JSON Claude Code piped in, or undefined when run from a shell
  // with no piped input. Injected so the resolution logic stays
  // testable without touching process.stdin.
  stdin: string | undefined;
}

// Claude Code's default window, and the extended tier. Both only
// matter on a manual run: when Claude Code invokes us it always sends
// the real size for the current model.
const DEFAULT_CONTEXT_WINDOW = 200_000;
const EXTENDED_CONTEXT_WINDOW = 1_000_000;

// Picks a window when the session json did not name one. Context that
// already exceeds the default proves the model is on the extended
// tier, so assuming the small window there would report a false 100%.
function assumeContextWindow(tokens: number): number {
  return tokens > DEFAULT_CONTEXT_WINDOW
    ? EXTENDED_CONTEXT_WINDOW
    : DEFAULT_CONTEXT_WINDOW;
}

interface StdinData {
  transcriptPath: string | undefined;
  // Undefined when the json carried no size, so the caller can pick
  // one from the context it measured.
  contextWindow: number | undefined;
}

function parseStdin(raw: string | undefined): StdinData {
  const empty: StdinData = {
    transcriptPath: undefined,
    contextWindow: undefined,
  };
  if (raw === undefined) return empty;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return empty;
  }
  const obj =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const path = obj.transcript_path;
  const window =
    typeof obj.context_window === "object" && obj.context_window !== null
      ? (obj.context_window as Record<string, unknown>).context_window_size
      : undefined;
  return {
    transcriptPath: typeof path === "string" && path !== "" ? path : undefined,
    contextWindow: typeof window === "number" && window > 0 ? window : undefined,
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

export async function runStatusline(
  flags: StatuslineFlags,
  input?: StatuslineInput,
): Promise<number> {
  const raw = input === undefined ? await readStdin() : input.stdin;
  // Claude Code piped us JSON. Any failure from here on must stay
  // quiet and exit 0 so the user's status line never shows an error.
  const invoked = raw !== undefined;
  const { transcriptPath, contextWindow } = parseStdin(raw);

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
  const window = contextWindow ?? assumeContextWindow(context.tokens);

  if (flags.json) {
    console.log(
      JSON.stringify({
        sessionId: summary.sessionId,
        model: context.model ?? summary.models[summary.models.length - 1],
        usd: summary.total.unknownModels.length > 0 ? null : summary.total.usd,
        contextTokens: context.tokens,
        contextWindow: window,
        turns: summary.turns,
        source: transcriptPath !== undefined ? "stdin" : "latest",
      }),
    );
    return 0;
  }

  for (const row of statuslinePanel(summary, context, {
    c: makeStyle(colorEnabledWhenCaptured(flags.color)),
    g: glyphsFor(flags.ascii),
    contextWindow: window,
  })) {
    console.log(row);
  }
  return 0;
}
