import { Logger } from '@nestjs/common';

const logger = new Logger('Pricing');

interface ModelRates {
  inputPerMToken: number;
  outputPerMToken: number;
  cacheReadPerMToken: number;
  cacheWritePerMToken: number;
}

const MODEL_PRICING: Record<string, ModelRates> = {
  'claude-sonnet-4-5-20250929': {
    inputPerMToken: 3,
    outputPerMToken: 15,
    cacheReadPerMToken: 0.3,
    cacheWritePerMToken: 3.75,
  },
  'claude-opus-4-6': {
    inputPerMToken: 15,
    outputPerMToken: 75,
    cacheReadPerMToken: 1.5,
    cacheWritePerMToken: 18.75,
  },
};

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/**
 * Calculate the USD cost for a single API call based on token usage.
 * Returns 0 with a warning log for unknown models rather than crashing.
 */
export function calculateCostUsd(model: string, usage: TokenUsage): number {
  const rates = MODEL_PRICING[model];
  if (!rates) {
    logger.warn(
      `Unknown model "${model}" — cannot calculate cost. Returning $0.00`,
    );
    return 0;
  }

  const inputCost = (usage.input_tokens / 1_000_000) * rates.inputPerMToken;
  const outputCost = (usage.output_tokens / 1_000_000) * rates.outputPerMToken;
  const cacheReadCost =
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
    rates.cacheReadPerMToken;
  const cacheWriteCost =
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
    rates.cacheWritePerMToken;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}
