/**
 * Gamma API client for Polymarket market lookups.
 * Maps token IDs to market details needed for CLOB trading.
 */
import type { TaskContext } from "compose";
import type { MarketInfo } from "./types";

/**
 * Look up market details by CLOB token ID.
 * Uses ctx.fetch (Compose's built-in HTTP client).
 */
export async function lookupMarketByTokenId(
  fetch: TaskContext["fetch"],
  gammaHost: string,
  tokenId: string
): Promise<MarketInfo | null> {
  try {
    const resp = await fetch(
      `${gammaHost}/markets?clob_token_ids=${encodeURIComponent(tokenId)}`
    );
    const markets = resp as any[];
    if (!markets?.length) return null;

    const m = markets[0];
    const clobTokenIds = JSON.parse(m.clobTokenIds || "[]");
    const outcomePrices = JSON.parse(m.outcomePrices || "[0,0]");

    return {
      tokenId,
      conditionId: m.conditionId,
      question: m.question,
      tickSize: m.orderPriceMinTickSize?.toString() || "0.01",
      // `negRisk` is the flag we want (NegRisk Exchange routing).
      // `negRiskOther` is unrelated (refers to companion markets in multi-outcome events).
      negRisk: m.negRisk === true,
      enableOrderBook: m.enableOrderBook === true,
      closed: m.closed === true,
      outcomePrices: [
        parseFloat(outcomePrices[0]) || 0,
        parseFloat(outcomePrices[1]) || 0,
      ],
      clobTokenIds: [clobTokenIds[0] || "", clobTokenIds[1] || ""],
    };
  } catch {
    return null;
  }
}

/**
 * Check if a market is resolved (closed with a clear winner).
 */
export function isResolved(market: MarketInfo): boolean {
  if (!market.closed) return false;
  return market.outcomePrices[0] >= 0.99 || market.outcomePrices[1] >= 0.99;
}

/**
 * Get the winning outcome index (0 = YES, 1 = NO).
 */
export function winningOutcomeIndex(market: MarketInfo): number | null {
  if (!market.closed) return null;
  if (market.outcomePrices[0] >= 0.99) return 0;
  if (market.outcomePrices[1] >= 0.99) return 1;
  return null;
}
