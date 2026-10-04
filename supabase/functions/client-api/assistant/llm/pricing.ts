/* Model prices for cost accounting (USD per million tokens).
 *
 * These feed `cost_micro_usd` in the allowance ledger, not an invoice: when a
 * price here is stale the ledger is off, the provider's bill is not. Check the
 * provider's price list when adding or changing a model. OpenAI rows were
 * written from the published list as known on 2026-10-03 and are NOT verified
 * by the live check (the API does not report prices).
 *
 * `cachedInput` is the rate for input tokens served from the provider's prompt
 * cache. Unknown models use DEFAULT_PRICE, which is deliberately high so an
 * unpriced model over-counts instead of running free.
 */

export interface ModelPrice {
  input: number;
  cachedInput: number;
  output: number;
}

export const DEFAULT_PRICE: ModelPrice = { input: 10, cachedInput: 10, output: 50 };

const PRICES: Record<string, ModelPrice> = {
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cachedInput: 0.02, output: 1.25 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15 },
  "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2 },
  "claude-haiku-4-5": { input: 1, cachedInput: 0.1, output: 5 },
  "claude-sonnet-5-5": { input: 2, cachedInput: 0.2, output: 10 },
  "claude-opus-5-5": { input: 4, cachedInput: 0.2, output: 20 },
};

/** Exact id first, then the id without a trailing date snapshot
 *  ("gpt-5.4-mini-2026-03-17" -> "gpt-5.4-mini"). */
export function priceFor(model: string): { price: ModelPrice; known: boolean } {
  const exact = PRICES[model];
  if (exact) return { price: exact, known: true };
  const base = model.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "");
  const snapshot = PRICES[base];
  if (snapshot) return { price: snapshot, known: true };
  return { price: DEFAULT_PRICE, known: false };
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  /** Subset of inputTokens that was served from cache. */
  cachedInputTokens: number;
}

/** Cost in millionths of a dollar, rounded up: never under-count. */
export function costMicroUsd(model: string, t: TokenCounts): number {
  const { price } = priceFor(model);
  const cached = Math.min(Math.max(0, t.cachedInputTokens), Math.max(0, t.inputTokens));
  const fresh = Math.max(0, t.inputTokens) - cached;
  // tokens * (USD per 1M tokens) is exactly micro-USD.
  return Math.ceil(fresh * price.input + cached * price.cachedInput + Math.max(0, t.outputTokens) * price.output);
}
