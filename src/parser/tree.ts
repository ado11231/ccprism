import type { RawLine } from "./types.js";

export interface TreeStats {
  // Where the leaf came from. A fallback means the session had no
  // usable last prompt line, which doctor should mention.
  leafSource: "last-prompt" | "last-line" | "none";
  // Kept lines that sit on abandoned branches, for example retries.
  inactiveLines: number;
  // A parent uuid was referenced but no line with that uuid exists.
  missingParents: number;
}

export interface ResolvedTree {
  // The active conversation, root first. Includes every line the
  // parent chain passes through, whatever its type.
  branch: RawLine[];
  // Each sidechain as its own ordered group, root first. Linking a
  // sidechain to the Task call that spawned it happens at the event
  // layer, where tool call content is parsed.
  sidechains: RawLine[][];
  // Lines on abandoned branches, for example retries. They stay out
  // of the transcript but their api calls still cost money, so the
  // event layer records their usage.
  inactive: RawLine[];
  stats: TreeStats;
}

function lastResolvableLeaf(
  lines: RawLine[],
  byUuid: Map<string, RawLine>,
): RawLine | undefined {
  let leaf: RawLine | undefined;
  for (const line of lines) {
    if (line.type !== "last-prompt" || line.leafUuid === undefined) continue;
    const target = byUuid.get(line.leafUuid);
    if (target !== undefined) leaf = target;
  }
  return leaf;
}

function lastMainLine(lines: RawLine[]): RawLine | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line !== undefined && line.uuid !== undefined && !line.isSidechain) {
      return line;
    }
  }
  return undefined;
}

export function resolveTree(lines: RawLine[]): ResolvedTree {
  const stats: TreeStats = {
    leafSource: "none",
    inactiveLines: 0,
    missingParents: 0,
  };

  const byUuid = new Map<string, RawLine>();
  for (const line of lines) {
    if (line.uuid !== undefined) byUuid.set(line.uuid, line);
  }

  let leaf = lastResolvableLeaf(lines, byUuid);
  if (leaf !== undefined) {
    stats.leafSource = "last-prompt";
  } else {
    leaf = lastMainLine(lines);
    if (leaf !== undefined) stats.leafSource = "last-line";
  }
  if (leaf === undefined) {
    return { branch: [], sidechains: [], inactive: [], stats };
  }

  // Children in file order, so the newest retry of a branch comes last.
  // A compact boundary has no physical parent but points back at the
  // old conversation through logicalParentUuid, so it registers as a
  // child of that line and the walk crosses compaction in both
  // directions.
  const childrenOf = new Map<string, RawLine[]>();
  for (const line of lines) {
    if (line.uuid === undefined) continue;
    const parentKey = line.parentUuid ?? line.logicalParentUuid;
    if (parentKey === undefined) continue;
    const siblings = childrenOf.get(parentKey);
    if (siblings === undefined) {
      childrenOf.set(parentKey, [line]);
    } else {
      siblings.push(line);
    }
  }

  // Walk backward from the leaf to the root.
  const branch: RawLine[] = [];
  const visited = new Set<string>();
  let current: RawLine | undefined = leaf;
  while (current !== undefined) {
    if (current.uuid !== undefined) {
      if (visited.has(current.uuid)) break;
      visited.add(current.uuid);
    }
    branch.push(current);
    const parentKey = current.parentUuid ?? current.logicalParentUuid;
    if (parentKey === undefined) break;
    const parent = byUuid.get(parentKey);
    if (parent === undefined) {
      stats.missingParents += 1;
      break;
    }
    current = parent;
  }
  branch.reverse();

  // Extend forward past the leaf. A live session file can already
  // hold response lines the last prompt line does not know about.
  // On a branch below the leaf, the newest sibling wins.
  let tip = leaf;
  while (tip.uuid !== undefined) {
    const children = (childrenOf.get(tip.uuid) ?? []).filter(
      (child) => !child.isSidechain && child.uuid !== undefined,
    );
    const next = children[children.length - 1];
    if (next === undefined || next.uuid === undefined) break;
    if (visited.has(next.uuid)) break;
    visited.add(next.uuid);
    branch.push(next);
    tip = next;
  }

  // Group sidechain lines into their own chains. A root is a
  // sidechain line whose parent is absent or not itself a sidechain.
  const sidechains: RawLine[][] = [];
  const claimed = new Set<RawLine>();
  for (const line of lines) {
    if (!line.isSidechain || claimed.has(line)) continue;
    const parent =
      line.parentUuid === null ? undefined : byUuid.get(line.parentUuid);
    const isRoot = parent === undefined || !parent.isSidechain;
    if (!isRoot) continue;
    const group = collectSubtreeInFileOrder(line, lines, childrenOf);
    for (const member of group) claimed.add(member);
    sidechains.push(group);
  }

  const active = new Set<RawLine>([...branch]);
  for (const group of sidechains) for (const member of group) active.add(member);
  const inactive: RawLine[] = [];
  for (const line of lines) {
    if (line.uuid !== undefined && !active.has(line)) inactive.push(line);
  }
  stats.inactiveLines = inactive.length;

  return { branch, sidechains, inactive, stats };
}

function collectSubtreeInFileOrder(
  root: RawLine,
  lines: RawLine[],
  childrenOf: Map<string, RawLine[]>,
): RawLine[] {
  const members = new Set<RawLine>([root]);
  const queue: RawLine[] = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || current.uuid === undefined) continue;
    for (const child of childrenOf.get(current.uuid) ?? []) {
      if (!members.has(child)) {
        members.add(child);
        queue.push(child);
      }
    }
  }
  return lines.filter((line) => members.has(line));
}
