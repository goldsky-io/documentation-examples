import type { TaskContext } from "compose";

import { CHAIN, CTF_ADDRESS } from "../lib/constants";
import type { Market, Outcome } from "../lib/types";
import { getOracleWallet } from "../lib/utils";

// Orchestrator snapshots closePrice onto the Market record before calling
// this task, so the closePrice is on the payload's market field.
export type TaskPayload = { market: Market & { closePrice: number } };

/**
 * Report binary payouts on an expired market.
 *
 * Outcome: closePrice >= openPrice → [1, 0] ("UP"), else [0, 1] ("DOWN").
 * Idempotent on "payout denominator already set".
 */
export async function main(
  context: TaskContext,
  { market }: TaskPayload,
): Promise<Market> {
  const { evm, collection } = context;
  const oracle = await getOracleWallet(context);
  const markets = await collection<Market>("markets");

  const ctf = new evm.contracts.ConditionalTokens(
    CTF_ADDRESS,
    evm.chains[CHAIN],
    oracle,
  );

  const outcome: Outcome = market.closePrice >= market.openPrice ? "UP" : "DOWN";
  const payouts: string[] = outcome === "UP" ? ["1", "0"] : ["0", "1"];

  try {
    const { hash } = await ctf.reportPayouts(market.questionId, payouts);
    const resolved: Market = {
      ...market,
      resolved: true,
      outcome,
      reportPayoutsTxHash: hash,
    };
    await markets.setById(market.questionId, resolved);
    return resolved;
  } catch (e) {
    if (
      e instanceof Error &&
      e.message.includes("payout denominator already set")
    ) {
      console.log(`market ${market.questionId} already resolved on-chain; persisting DB record only`);
      const resolved: Market = { ...market, resolved: true, outcome };
      await markets.setById(market.questionId, resolved);
      return resolved;
    }
    throw e;
  }
}
