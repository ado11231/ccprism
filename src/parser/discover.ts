import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionFile {
  filePath: string;
  // File name without the .jsonl suffix.
  sessionId: string;
  // Directory name under the projects root. It encodes the project
  // path with slashes turned into dashes, which cannot be decoded
  // reliably, so the real path comes from the session meta instead.
  projectSlug: string;
  modifiedAt: Date;
  sizeBytes: number;
}

export function defaultProjectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

// Lists every session file under the projects root, newest first.
// A missing or unreadable root just means no sessions.
export async function discoverSessionFiles(
  root: string = defaultProjectsRoot(),
): Promise<SessionFile[]> {
  let projectDirs;
  try {
    projectDirs = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: SessionFile[] = [];
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = join(root, dir.name);
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = join(dirPath, entry.name);
      let info;
      try {
        info = await stat(filePath);
      } catch {
        continue;
      }
      files.push({
        filePath,
        sessionId: entry.name.slice(0, -".jsonl".length),
        projectSlug: dir.name,
        modifiedAt: info.mtime,
        sizeBytes: info.size,
      });
    }
  }

  files.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return files;
}
