/**
 * redeem — cron task (every 5 min)
 *
 * Queries Polymarket's data API for our wallet's redeemable positions and
 * calls redeemPositions() on-chain for each. Polymarket marks a position
 * `redeemable: true` when its condition has resolved on-chain.
 *
 * This intentionally doesn't use the local `positions` collection — the data
 * API is the source of truth and already knows the conditionId + outcomeIndex
 * for every share we hold, including trades that happened before this task
 * existed or that didn't get recorded locally.
 */
import type { TaskContext } from "compose";
import { CONTRACTS } from "../lib/types";
import { privateKeyToAccount } from "viem/accounts";

const CONDITIONAL_TOKENS_ABI =
  "redeemPositions(address,bytes32,bytes32,uint256[])";

type DataApiPosition = {
  asset: string;
  conditionId: string;
  title: string;
  outcomeIndex: number;
  size: number;
  currentValue: number;
  redeemable: boolean;
  // Multi-outcome markets have outcomeCount > 2; binary markets have 2.
  // For a binary market, indexSets are: outcome 0 → 1, outcome 1 → 2.
};

export async function main(ctx: TaskContext) {
  const pk = ctx.env.PRIVATE_KEY as `0x${string}`;
  const address = privateKeyToAccount(
    pk.startsWith("0x") ? pk : (`0x${pk}` as `0x${string}`)
  ).address;

  // sizeThreshold=0 is required: Polymarket's default threshold is 1.0, which
  // hides any position holding <1 share. Fills that land just under 1 share
  // (e.g. 0.9985 when buying at $0.99 due to fee routing) would otherwise
  // never surface here, and winning positions of that size would sit
  // un-redeemed indefinitely.
  const resp = (await ctx.fetch(
    `https://data-api.polymarket.com/positions?user=${address}&limit=100&sortBy=CURRENT&sortOrder=DESC&sizeThreshold=0`
  )) as DataApiPosition[];

  const toRedeem = (resp ?? []).filter(
    (p) => p.redeemable === true && p.size > 0
  );

  if (!toRedeem.length) {
    console.log("[redeem] no redeemable positions");
    return { redeemed: 0 };
  }

  console.log(`[redeem] ${toRedeem.length} redeemable positions`);

  const wallet = await ctx.evm.wallet({
    name: "copy-trader",
    privateKey: pk,
    sponsorGas: true,
  });

  const parentCollectionId =
    "0x0000000000000000000000000000000000000000000000000000000000000000";
  const results: Array<{ condition: string; tx?: string; error?: string }> = [];

  // Dedupe: redeeming one conditionId burns both YES and NO shares we hold
  const seenConditions = new Set<string>();

  for (const pos of toRedeem) {
    if (seenConditions.has(pos.conditionId)) continue;
    seenConditions.add(pos.conditionId);

    // Binary market: indexSet 1 = outcome 0 (YES), indexSet 2 = outcome 1 (NO).
    // Passing both [1, 2] redeems whatever we hold in one call.
    const indexSets = [1, 2];

    try {
      console.log(
        `[redeem] redeeming condition ${pos.conditionId.slice(0, 12)}... (${pos.title.slice(0, 40)})`
      );
      const tx = await wallet.writeContract(
        ctx.evm.chains.polygon,
        CONTRACTS.conditionalTokens as `0x${string}`,
        CONDITIONAL_TOKENS_ABI,
        [CONTRACTS.usdc, parentCollectionId, pos.conditionId, indexSets]
      );
      console.log(`[redeem] redeemed: ${tx.hash}`);
      results.push({ condition: pos.conditionId, tx: tx.hash });
    } catch (err) {
      console.log(`[redeem] error for ${pos.conditionId}: ${err}`);
      results.push({ condition: pos.conditionId, error: String(err) });
    }
  }

  return { redeemed: results.length, results };
}
