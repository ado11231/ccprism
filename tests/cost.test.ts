import { describe, expect, it } from "vitest";
import {
  costOfUsage,
  knownModels,
  pricingFor,
  SYNTHETIC_MODEL,
} from "../src/cost/cost.js";
import type { Usage } from "../src/parser/events.js";

function usage(partial: Partial<Usage>): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreationTotal: 0,
    cacheCreation5m: undefined,
    cacheCreation1h: undefined,
    ...partial,
  };
}

describe("costOfUsage", () => {
  it("prices one million input tokens at the input rate", () => {
    const cost = costOfUsage(usage({ input: 1_000_000 }), "claude-opus-4-8");
    expect(cost).toBe(5);
  });

  it("prices every tier with the cache write split", () => {
    const cost = costOfUsage(
      usage({
        input: 1000,
        output: 2000,
        cacheRead: 10_000,
        cacheCreationTotal: 3500,
        cacheCreation5m: 3000,
        cacheCreation1h: 500,
      }),
      "claude-fable-5",
    );
    // (1000*10 + 2000*50 + 10000*1 + 3000*12.5 + 500*20) / 1e6
    expect(cost).toBeCloseTo(0.1675, 10);
  });

  it("prices the whole cache write total at the 5m tier without a split", () => {
    const cost = costOfUsage(
      usage({ cacheCreationTotal: 4000 }),
      "claude-opus-4-8",
    );
    expect(cost).toBeCloseTo(0.025, 10);
  });

  it("uses the split even when one lifetime is zero", () => {
    const cost = costOfUsage(
      usage({ cacheCreationTotal: 500, cacheCreation5m: 0, cacheCreation1h: 500 }),
      "claude-opus-4-8",
    );
    expect(cost).toBeCloseTo(0.005, 10);
  });

  it("prices synthetic messages at zero", () => {
    const cost = costOfUsage(usage({ input: 999, output: 999 }), SYNTHETIC_MODEL);
    expect(cost).toBe(0);
  });

  it("returns undefined for an unknown model", () => {
    expect(costOfUsage(usage({ input: 100 }), "claude-future-9")).toBeUndefined();
  });
});

describe("pricing table", () => {
  it("covers the model ids seen in real logs on this machine", () => {
    expect(pricingFor("claude-opus-4-8")).toBeDefined();
    expect(pricingFor("claude-fable-5")).toBeDefined();
  });

  it("has five positive finite rates per model, sanely ordered", () => {
    for (const model of knownModels()) {
      const p = pricingFor(model);
      expect(p).toBeDefined();
      if (p === undefined) continue;
      for (const rate of [
        p.input,
        p.output,
        p.cacheRead,
        p.cacheWrite5m,
        p.cacheWrite1h,
      ]) {
        expect(Number.isFinite(rate)).toBe(true);
        expect(rate).toBeGreaterThan(0);
      }
      // Cache reads are the discount tier, cache writes the premium.
      expect(p.cacheRead).toBeLessThan(p.input);
      expect(p.cacheWrite5m).toBeGreaterThan(p.input);
      expect(p.cacheWrite1h).toBeGreaterThan(p.cacheWrite5m);
      expect(p.output).toBeGreaterThan(p.input);
    }
  });
});
