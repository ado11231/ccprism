export function fmtUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

export function fmtPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function fmtTokens(count: number): string {
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [size, suffix] of units) {
    if (count >= size) {
      const value = count / size;
      return (value >= 100 ? value.toFixed(0) : value.toFixed(1)) + suffix;
    }
  }
  return String(count);
}

export function fmtDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Compact local time reference: clock time today, month and day this
// year, full date otherwise.
export function fmtWhen(iso: string | undefined, now = new Date()): string {
  if (iso === undefined) return "?";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "?";
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    const h = String(date.getHours()).padStart(2, "0");
    const m = String(date.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function shortId(id: string | undefined): string {
  return id === undefined ? "????????" : id.slice(0, 8);
}

export function shortModel(model: string): string {
  return model.startsWith("claude-") ? model.slice("claude-".length) : model;
}

// Pads plain text cells into aligned columns. Styling happens after
// padding so ansi codes never break the alignment.
export function renderTable(
  rows: string[][],
  align: ("left" | "right")[],
): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => {
        const width = widths[i] ?? 0;
        return align[i] === "right" ? cell.padStart(width) : cell.padEnd(width);
      })
      .join("  ")
      .trimEnd(),
  );
}
