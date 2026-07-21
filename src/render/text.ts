import stringWidth from "string-width";

// Wrapping works on plain text before any styling is applied, the
// same rule renderTable follows: measure and break first, color
// later, so ansi codes can never distort the layout.

export function displayWidth(text: string): number {
  return stringWidth(text);
}

// The transcript column: the terminal, capped at 100 so long prose
// stays readable in wide windows.
export function contentWidth(
  columns: number | undefined = process.stdout.columns,
): number {
  return Math.min(columns ?? 80, 100);
}

// Breaks one overlong word by display width, for tokens like urls
// that have no spaces to break at.
function hardBreak(word: string, width: number): string[] {
  const pieces: string[] = [];
  let piece = "";
  let pieceWidth = 0;
  for (const char of word) {
    const charWidth = stringWidth(char);
    if (pieceWidth + charWidth > width && piece !== "") {
      pieces.push(piece);
      piece = "";
      pieceWidth = 0;
    }
    piece += char;
    pieceWidth += charWidth;
  }
  if (piece !== "") pieces.push(piece);
  return pieces;
}

function wrapLine(line: string, width: number): string[] {
  const wrapped: string[] = [];
  let current = "";
  let currentWidth = 0;

  const flush = (): void => {
    if (current !== "") {
      wrapped.push(current);
      current = "";
      currentWidth = 0;
    }
  };

  for (const word of line.split(" ")) {
    const wordWidth = stringWidth(word);
    const separator = current === "" ? 0 : 1;
    if (currentWidth + separator + wordWidth <= width) {
      current = current === "" ? word : `${current} ${word}`;
      currentWidth += separator + wordWidth;
      continue;
    }
    flush();
    if (wordWidth <= width) {
      current = word;
      currentWidth = wordWidth;
      continue;
    }
    const pieces = hardBreak(word, width);
    const last = pieces.pop();
    wrapped.push(...pieces);
    if (last !== undefined) {
      current = last;
      currentWidth = stringWidth(last);
    }
  }
  flush();
  // A blank input line stays a line, so paragraph breaks survive.
  return wrapped.length === 0 ? [""] : wrapped;
}

// Wraps plain text to a display width, preserving existing newlines
// as paragraph structure. Returns the individual output lines.
export function wrapPlain(text: string, width: number): string[] {
  if (width <= 0) return text.split("\n");
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    lines.push(...wrapLine(line, width));
  }
  return lines;
}

// Cuts overlong text to a display width, marking the cut with an
// ellipsis at the end. Keeps the head, so it suits prose and commands
// where the start carries the meaning.
export function truncate(text: string, width: number, ellipsis: string): string {
  if (displayWidth(text) <= width) return text;
  const room = width - displayWidth(ellipsis);
  if (room <= 0) return ellipsis;
  let out = "";
  let used = 0;
  for (const char of text) {
    const charWidth = displayWidth(char);
    if (used + charWidth > room) break;
    out += char;
    used += charWidth;
  }
  return `${out}${ellipsis}`;
}

// The last `columns` display columns of text, whole characters only.
function keepTail(text: string, columns: number): string {
  const chars = [...text];
  let out = "";
  let used = 0;
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const char = chars[i] as string;
    const charWidth = displayWidth(char);
    if (used + charWidth > columns) break;
    out = char + out;
    used += charWidth;
  }
  return out;
}

// Cuts an overlong path from the front, keeping the basename visible,
// since the file name is the informative end of a path. The ellipsis
// replaces whole leading segments so none is left half spelled: it
// keeps the most trailing segments that still fit, like
// a/very/long/path/to/file.ts -> …/path/to/file.ts. When even the
// basename cannot fit, the name itself is cut from the front.
export function truncatePath(path: string, width: number, ellipsis: string): string {
  if (displayWidth(path) <= width) return path;
  const ellipsisWidth = displayWidth(ellipsis);
  for (let i = 0; i < path.length; i += 1) {
    if (path[i] !== "/") continue;
    const suffix = path.slice(i);
    if (ellipsisWidth + displayWidth(suffix) <= width) {
      return `${ellipsis}${suffix}`;
    }
  }
  return `${ellipsis}${keepTail(path, width - ellipsisWidth)}`;
}
