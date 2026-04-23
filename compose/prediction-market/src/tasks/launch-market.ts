import type { TaskContext } from "compose";

import {
  ASSET_PAIR,
  CHAIN,
  CTF_ADDRESS,
  DURATION_MS,
  DURATION_SEC,
} from "../lib/constants";
import type { Market } from "../lib/types";
import { computeQuestionId, getOracleWallet } from "../lib/utils";

export type TaskPayload = { startTime: number; openPrice: number };

/**
 * Prepare a new condition on the CTF for the given 5-min window.
 *
 * Idempotent: if a prior attempt already landed the transaction, the CTF
 * reverts with "condition already prepared"; we catch that, persist the DB
 * record, and move on.
 */
export async function main(
  context: TaskContext,
  { startTime, openPrice }: TaskPayload,
): Promise<Market> {
  const { evm, collection } = context;
  const oracle = await getOracleWallet(context);
  const markets = await collection<Market>("markets");

  const questionId = computeQuestionId({
    assetPair: ASSET_PAIR,
    durationSec: DURATION_SEC,
    startTimestampSec: Math.floor(startTime / 1000),
  });
  const endTime = startTime + DURATION_MS;

  try {
    const { hash } = await oracle.writeContract(
      evm.chains[CHAIN],
      CTF_ADDRESS,
      "prepareCondition(address,bytes32,uint256)",
      [oracle.address, questionId, "2"],
    );
    const market: Market = {
      questionId,
      assetPair: ASSET_PAIR,
      durationSec: DURATION_SEC,
      startTime,
      endTime,
      openPrice,
      resolved: false,
      prepareConditionTxHash: hash,
    };
    await markets.setById(questionId, market, { upsert: true });
    return market;
  } catch (e) {
    if (
      e instanceof Error &&
      e.message.includes("condition already prepared")
    ) {
      console.log(`condition already prepared for ${questionId}; persisting DB record only`);
      const market: Market = {
        questionId,
        assetPair: ASSET_PAIR,
        durationSec: DURATION_SEC,
        startTime,
        endTime,
        openPrice,
        resolved: false,
        prepareConditionTxHash: null,
      };
      await markets.setById(questionId, market, { upsert: true });
      return market;
    }
    throw e;
  }
}
