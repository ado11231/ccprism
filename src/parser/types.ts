// Raw shapes coming out of a session JSONL file. Field values are
// checked at read time because the log format drifts between Claude
// Code versions and the parser must never crash on it.

export interface RawLine {
  type: string;
  uuid: string | undefined;
  parentUuid: string | null;
  isSidechain: boolean;
  timestamp: string | undefined;
  leafUuid: string | undefined;
  // The full original line for fields the typed view does not cover.
  data: Record<string, unknown>;
}

export interface ReadStats {
  totalLines: number;
  keptLines: number;
  ignoredLines: number;
  malformedLines: number;
  // Type names the parser does not recognize, with how often each
  // appeared. Surfaced by doctor so format drift is visible.
  unknownTypes: Record<string, number>;
}

export interface ReadResult {
  lines: RawLine[];
  stats: ReadStats;
}
