import { describe, expect, it } from "vitest";
import { emptyRollup, type SessionSummary } from "../src/cost/aggregate.js";
import { ansiToHtml, toHtml, toMarkdown } from "../src/render/export.js";
import { makeStyle } from "../src/render/style.js";

const c = makeStyle(true);

function summary(): SessionSummary {
  return {
    sessionId: "13af1923-3b85-44dc-9715-0af802703bd6",
    projectSlug: "-scrubbed-project",
    filePath: "/tmp/x.jsonl",
    cwd: "/tmp",
    gitBranch: "main",
    version: "2.0.0",
    models: ["claude-opus-4-8"],
    firstTimestamp: "2026-07-20T19:00:00.000Z",
    lastTimestamp: "2026-07-20T19:30:00.000Z",
    durationMs: 1_800_000,
    longestGapMs: 1000,
    turns: 3,
    total: { ...emptyRollup(), usd: 0.42 },
    sidechain: emptyRollup(),
    offBranch: emptyRollup(),
  };
}

describe("ansiToHtml", () => {
  it("escapes html in plain text", () => {
    expect(ansiToHtml("a <b> & c")).toBe("a &lt;b&gt; &amp; c");
  });

  it("turns a styled run into one span and closes it", () => {
    const html = ansiToHtml(c.dim("quiet"));
    expect(html).toBe('<span class="d">quiet</span>');
  });

  it("carries color and weight together", () => {
    const html = ansiToHtml(c.bold(c.cyan("YOU")));
    expect(html).toContain("c36");
    expect(html).toContain("b");
    expect(html).toContain(">YOU<");
  });

  // Anything the terminal renderer never emits still has to leave the
  // text intact rather than swallowing it.
  it("ignores codes it does not model", () => {
    expect(ansiToHtml("[38;5;200mpink[0m")).toContain("pink");
  });

  it("leaves text with no escapes untouched", () => {
    expect(ansiToHtml("● YOU")).toBe("● YOU");
  });
});

describe("toMarkdown", () => {
  const lines = ["header line", "● YOU", "  hello"];

  it("titles the document and keeps the body in a fence", () => {
    const md = toMarkdown(lines, summary());
    expect(md).toContain("# session 13af1923");
    expect(md).toContain("opus-4-8 · $0.42 · 3 turns · 30m");
    expect(md).toContain("● YOU");
    // The rendered header is replaced by the title, not repeated.
    expect(md).not.toContain("header line");
  });

  // A transcript can hold a code block of its own, so the fence has to
  // be one no ordinary content closes.
  it("fences with four backticks", () => {
    const md = toMarkdown(["header", "```js", "x", "```"], summary());
    expect(md).toContain("````text");
    expect(md.trimEnd().endsWith("````")).toBe(true);
  });
});

describe("toHtml", () => {
  it("writes one self contained page", () => {
    const html = toHtml(["header", c.bold("● YOU"), "  <script>"], summary());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>session 13af1923</title>");
    expect(html).toContain('<span class="b">● YOU</span>');
    // Session text is escaped, so nothing in a transcript can run.
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    // Nothing is fetched: no scripts, no fonts, no stylesheets.
    expect(html).not.toContain("http");
    expect(html).not.toContain("<link");
  });

  it("styles for both light and dark", () => {
    const html = toHtml(["header", "x"], summary());
    expect(html).toContain("prefers-color-scheme: dark");
  });
});
