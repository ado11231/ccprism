import { describe, expect, it } from "vitest";
import {
  fmtDuration,
  fmtTokens,
  fmtUsd,
  fmtWhen,
  renderTable,
  shortId,
  shortModel,
} from "../src/render/format.js";

describe("formatting", () => {
  it("formats dollars with cents", () => {
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(538.8947)).toBe("$538.89");
  });

  it("formats token counts with unit suffixes", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1234)).toBe("1.2k");
    expect(fmtTokens(45_600_000)).toBe("45.6M");
    expect(fmtTokens(675_741_715)).toBe("676M");
    expect(fmtTokens(1_200_000_000)).toBe("1.2B");
  });

  it("formats durations at a readable grain", () => {
    expect(fmtDuration(42_000)).toBe("42s");
    expect(fmtDuration(6 * 60_000)).toBe("6m");
    expect(fmtDuration(72 * 60_000)).toBe("1h 12m");
    expect(fmtDuration(30 * 60 * 60_000)).toBe("1d 6h");
  });

  it("formats timestamps relative to now", () => {
    const now = new Date(2026, 6, 17, 15, 0);
    const today = new Date(2026, 6, 17, 4, 5).toISOString();
    const thisYear = new Date(2026, 0, 3, 12, 0).toISOString();
    const lastYear = new Date(2025, 10, 2, 12, 0).toISOString();
    expect(fmtWhen(today, now)).toBe("04:05");
    expect(fmtWhen(thisYear, now)).toBe("Jan 3");
    expect(fmtWhen(lastYear, now)).toBe("2025-11-02");
    expect(fmtWhen(undefined, now)).toBe("?");
  });

  it("shortens ids and model names", () => {
    expect(shortId("2b177ab9-f78d-43b0-b5e6-5f6354f3fc21")).toBe("2b177ab9");
    expect(shortId(undefined)).toBe("????????");
    expect(shortModel("claude-opus-4-8")).toBe("opus-4-8");
    expect(shortModel("<synthetic>")).toBe("<synthetic>");
  });

  it("aligns table columns", () => {
    const lines = renderTable(
      [
        ["id", "cost"],
        ["abc", "$1.00"],
        ["longer-id", "$10.00"],
      ],
      ["left", "right"],
    );
    expect(lines).toEqual([
      "id           cost",
      "abc         $1.00",
      "longer-id  $10.00",
    ]);
  });
});
