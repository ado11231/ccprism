import pc from "picocolors";

export type Style = ReturnType<typeof pc.createColors>;

// Styling is off when the user says so, when the NO_COLOR convention
// is set, or when output is piped. Structure must carry the layout
// on its own, color only reinforces it.
export function colorEnabled(flagColor: boolean): boolean {
  if (!flagColor) return false;
  if (process.env.NO_COLOR !== undefined) return false;
  return process.stdout.isTTY === true;
}

export function makeStyle(enabled: boolean): Style {
  return pc.createColors(enabled);
}
