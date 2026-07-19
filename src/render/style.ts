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

// Truecolor by the COLORTERM convention. The palette stays 16 color
// either way, this only gates optional reinforcement.
export function supportsTruecolor(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const colorterm = env.COLORTERM ?? "";
  return colorterm.includes("truecolor") || colorterm.includes("24bit");
}

// There is no reliable italic capability query worth shipping. The
// practical rule: modern emulators render italics, and the console
// and multiplexer cases that do not announce themselves in TERM.
// When italics are off, dim alone carries the thinking style.
export function supportsItalic(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const term = env.TERM ?? "";
  if (term === "dumb" || term === "linux") return false;
  if (term.startsWith("screen")) return false;
  return true;
}
