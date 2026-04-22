import type { TaskContext } from "compose";

import { ASSET_PAIR, DURATION_SEC } from "../lib/constants";
import type { Market } from "../lib/types";
import { computeQuestionId, floorToMarketStart } from "../lib/utils";

import type { TaskPayload as LaunchPayload } from "./launch-market";
import type { ResponsePayload as PriceData } from "./market-data";
import type { TaskPayload as ResolvePayload } from "./resolve-market";

/**
 * Cron orchestrator — fires every 5 minutes.
 *
 *   1. Fetch current BTC price. (One HTTP call; the value IS both the
 *      closing tick of the previous market and the opening tick of the new
 *      one, since both sit on the 5-min bucket boundary.)
 *   2. Resolve any markets whose endTime has passed.
 *   3. Launch a fresh market for the current 5-min bucket.
 */
export async function main(context: TaskContext) {
  const { collection, callTask, logEvent } = context;
  const nowMs = Date.now();
  const currentMarketStart = floorToMarketStart(nowMs);

  const markets = await collection<Market>("markets", [
    { path: "endTime", type: "numeric" },
    { path: "resolved", type: "boolean" },
  ]);

  // 1) Fetch current price — used for both resolve and launch this cycle.
  const { priceUsd } = await callTask<Record<string, never>, PriceData>(
    "market_data",
    {},
  );

  // 2) Resolve any overdue, unresolved markets.
  const overdue = await markets.findMany({
    endTime: { $lte: nowMs },
    resolved: false,
  });

  let resolved = 0;
  let resolveErrors = 0;
  for (const market of overdue) {
    // Snapshot closePrice before the chain call so retries produce a
    // deterministic verdict even if prices move.
    const closePrice = market.closePrice ?? priceUsd;
    if (market.closePrice === undefined) {
      await markets.setById(market.questionId, { ...market, closePrice });
    }
    try {
      await callTask<ResolvePayload, Market>("resolve_market", {
        market: { ...market, closePrice },
      });
      resolved++;
    } catch (e) {
      resolveErrors++;
      console.error(`resolve ${market.questionId}:`, e);
    }
  }

  // 3) Launch the market for the current 5-min bucket, if not already.
  const currentQid = computeQuestionId({
    assetPair: ASSET_PAIR,
    durationSec: DURATION_SEC,
    startTimestampSec: Math.floor(currentMarketStart / 1000),
  });
  const existing = await markets.getById(currentQid);
  let launched = false;
  let launchError = false;
  if (!existing) {
    try {
      await callTask<LaunchPayload, Market>("launch_market", {
        startTime: currentMarketStart,
        openPrice: priceUsd,
      });
      launched = true;
    } catch (e) {
      launchError = true;
      console.error(`launch ${currentQid}:`, e);
    }
  }

  const ok = resolveErrors === 0 && !launchError;
  await logEvent({
    code: ok ? "ORCHESTRATOR_SUCCESS" : "ORCHESTRATOR_FAILURE",
    message: `resolved=${resolved}/${overdue.length} launched=${launched} resolveErrors=${resolveErrors} launchError=${launchError}`,
    data: JSON.stringify({ priceUsd, nowMs, currentMarketStart }),
  });

  return {
    priceUsd,
    resolved,
    overdueCount: overdue.length,
    launched,
    resolveErrors,
    launchError,
  };
}
