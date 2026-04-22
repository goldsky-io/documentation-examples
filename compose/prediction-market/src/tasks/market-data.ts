import type { TaskContext } from "compose";

import { PRICE_URL } from "../lib/constants";

export type TaskPayload = Record<string, never>;
export type ResponsePayload = { priceUsd: number; fetchedAtMs: number };

/**
 * Fetch the current BTC/USD spot price from CoinGecko.
 *
 * Called once per cron cycle — the result is used as BOTH the closePrice of
 * the expiring market AND the openPrice of the market being launched this
 * cycle (the 5-min bucket boundary is the same moment for both).
 */
export async function main(context: TaskContext): Promise<ResponsePayload> {
  const response = await context.fetch<{ bitcoin?: { usd?: number } }>(
    PRICE_URL,
    {
      max_attempts: 3,
      initial_interval_ms: 1000,
      backoff_factor: 2,
    },
  );

  const priceUsd = response?.bitcoin?.usd;
  if (typeof priceUsd !== "number" || priceUsd <= 0) {
    throw new Error(
      `Unexpected CoinGecko response shape: ${JSON.stringify(response)}`,
    );
  }

  return { priceUsd, fetchedAtMs: Date.now() };
}
