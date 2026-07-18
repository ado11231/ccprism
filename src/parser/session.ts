import { extractSession, type ExtractedSession } from "./events.js";
import { readSessionFile } from "./reader.js";
import { resolveTree, type TreeStats } from "./tree.js";
import type { ReadStats } from "./types.js";

export interface ParsedSessionFile {
  session: ExtractedSession;
  readStats: ReadStats;
  treeStats: TreeStats;
}

// The full pipeline for one file: read, resolve the tree, extract.
export async function parseSessionFile(
  path: string,
): Promise<ParsedSessionFile> {
  const read = await readSessionFile(path);
  const tree = resolveTree(read.lines);
  return {
    session: extractSession(tree),
    readStats: read.stats,
    treeStats: tree.stats,
  };
}
