import { describe, expect, it } from "vitest";
import { ASCII_GLYPHS, UNICODE_GLYPHS, glyphsFor } from "../src/render/glyphs.js";
import { supportsItalic, supportsTruecolor } from "../src/render/style.js";
import {
  contentWidth,
  displayWidth,
  truncate,
  truncatePath,
  wrapPlain,
} from "../src/render/text.js";

describe("displayWidth", () => {
  it("counts plain ascii by character", () => {
    expect(displayWidth("hello")).toBe(5);
  });

  it("counts wide characters as two columns", () => {
    expect(displayWidth("日本")).toBe(4);
    expect(displayWidth("🎉")).toBe(2);
  });
});

describe("contentWidth", () => {
  it("caps wide terminals at 100", () => {
    expect(contentWidth(250)).toBe(100);
  });

  it("follows narrow terminals", () => {
    expect(contentWidth(60)).toBe(60);
  });

  it("assumes 80 when the width is unknown", () => {
    expect(contentWidth(undefined)).toBe(80);
  });
});

describe("wrapPlain", () => {
  it("wraps at word boundaries", () => {
    expect(wrapPlain("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
  });

  it("keeps short text on one line", () => {
    expect(wrapPlain("short", 80)).toEqual(["short"]);
  });

  it("preserves paragraph breaks", () => {
    expect(wrapPlain("one\n\ntwo", 80)).toEqual(["one", "", "two"]);
  });

  it("hard breaks words wider than the line", () => {
    expect(wrapPlain("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
  });

  it("continues after a hard broken word", () => {
    expect(wrapPlain("abcdefgh xy", 4)).toEqual(["abcd", "efgh", "xy"]);
  });

  it("wraps by display width, not character count", () => {
    expect(wrapPlain("日本 語語", 4)).toEqual(["日本", "語語"]);
  });

  it("returns unwrapped lines when the width is zero or negative", () => {
    expect(wrapPlain("aaa bbb\nccc", 0)).toEqual(["aaa bbb", "ccc"]);
  });
});

describe("truncate", () => {
  it("leaves text that fits untouched", () => {
    expect(truncate("short", 10, "…")).toBe("short");
  });

  it("cuts from the end and marks it, keeping the head", () => {
    expect(truncate("abcdefgh", 5, "…")).toBe("abcd…");
  });

  it("measures the ellipsis against the width budget", () => {
    expect(displayWidth(truncate("abcdefgh", 5, "..."))).toBeLessThanOrEqual(5);
  });
});

describe("truncatePath", () => {
  it("leaves a path that fits untouched", () => {
    expect(truncatePath("src/a.ts", 20, "…")).toBe("src/a.ts");
  });

  it("keeps the basename and cuts leading directories", () => {
    const out = truncatePath("a/very/long/path/to/file.ts", 16, "…");
    expect(out).toContain("file.ts");
    expect(out.startsWith("…")).toBe(true);
    expect(displayWidth(out)).toBeLessThanOrEqual(16);
  });

  it("keeps whole trailing segments, cutting on a separator", () => {
    // "path/to/file.ts" stays whole rather than "…th/to/file.ts".
    expect(truncatePath("a/very/long/path/to/file.ts", 18, "…")).toBe(
      "…/path/to/file.ts",
    );
  });

  it("front-cuts the basename when even it will not fit", () => {
    const out = truncatePath("some/directory/verylongfilename.ts", 10, "…");
    expect(out.startsWith("…")).toBe(true);
    expect(out).not.toContain("/");
    expect(displayWidth(out)).toBeLessThanOrEqual(10);
  });
});

describe("glyph sets", () => {
  it("swap as one shape", () => {
    expect(Object.keys(ASCII_GLYPHS).sort()).toEqual(
      Object.keys(UNICODE_GLYPHS).sort(),
    );
    expect(Object.keys(ASCII_GLYPHS.tools).sort()).toEqual(
      Object.keys(UNICODE_GLYPHS.tools).sort(),
    );
    expect(glyphsFor(true)).toBe(ASCII_GLYPHS);
    expect(glyphsFor(false)).toBe(UNICODE_GLYPHS);
  });

  it("keeps the ascii set printable ascii only", () => {
    const marks = [
      ...Object.values(ASCII_GLYPHS.tools),
      ASCII_GLYPHS.user,
      ASCII_GLYPHS.claude,
      ASCII_GLYPHS.thinking,
      ASCII_GLYPHS.connector,
      ASCII_GLYPHS.rule,
      ASCII_GLYPHS.dot,
    ];
    for (const mark of marks) {
      expect(mark).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

describe("terminal feature detection", () => {
  it("detects truecolor from COLORTERM", () => {
    expect(supportsTruecolor({ COLORTERM: "truecolor" })).toBe(true);
    expect(supportsTruecolor({ COLORTERM: "24bit" })).toBe(true);
    expect(supportsTruecolor({})).toBe(false);
  });

  it("declines italics on consoles and multiplexers", () => {
    expect(supportsItalic({ TERM: "xterm-256color" })).toBe(true);
    expect(supportsItalic({ TERM: "dumb" })).toBe(false);
    expect(supportsItalic({ TERM: "linux" })).toBe(false);
    expect(supportsItalic({ TERM: "screen-256color" })).toBe(false);
  });
});
