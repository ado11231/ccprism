import type { Usage } from "../parser/events.js";
import pricingTable from "./pricing.json";

// Prices are USD per million tokens. The five tiers exist because
// real logs price cache writes by lifetime: 5 minute entries cost
// 1.25x the input rate and 1 hour entries cost 2x.
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

// Claude Code writes this model id on locally generated placeholder
// messages. They never hit the api, so they are priced at zero
// instead of being reported as an unknown model.
export const SYNTHETIC_MODEL = "<synthetic>";

const PRICING: Record<string, ModelPricing> = pricingTable;

export function pricingFor(model: string): ModelPricing | undefined {
  return PRICING[model];
}

export function knownModels(): string[] {
  return Object.keys(PRICING);
}

const TOKENS_PER_MILLION = 1_000_000;

// Returns the cost in USD, or undefined when the model is missing
// from the pricing table. Undefined means the dashboard shows tokens
// with the cost marked unknown, never a made up number.
export function costOfUsage(usage: Usage, model: string): number | undefined {
  if (model === SYNTHETIC_MODEL) return 0;
  const pricing = PRICING[model];
  if (pricing === undefined) return undefined;

  // Older logs report only the cache write total without the
  // lifetime split. Price it all at the 5 minute tier then.
  const write5m = usage.cacheCreation5m ?? usage.cacheCreationTotal;
  const write1h = usage.cacheCreation1h ?? 0;

  return (
    (usage.input * pricing.input +
      usage.output * pricing.output +
      usage.cacheRead * pricing.cacheRead +
      write5m * pricing.cacheWrite5m +
      write1h * pricing.cacheWrite1h) /
    TOKENS_PER_MILLION
  );
}
