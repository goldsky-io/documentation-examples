import {
  concat,
  keccak256,
  numberToHex,
  stringToHex,
  type Hex,
} from "viem";
import type { TaskContext, IWallet } from "compose";

import { DURATION_MS, ORACLE_WALLET_NAME, SALT } from "./constants";

/**
 * Deterministically derive a CTF questionId from the market's parameters.
 *
 * The oracle address is intentionally NOT mixed in — the CTF computes
 * conditionId = keccak256(abi.encode(oracle, questionId, outcomeSlotCount))
 * itself, so two deploys with different oracle EOAs already get distinct
 * conditions on-chain even if questionIds happen to collide.
 */
export function computeQuestionId(args: {
  assetPair: string;
  durationSec: number;
  startTimestampSec: number;
}): Hex {
  return keccak256(
    concat([
      stringToHex(SALT, { size: 32 }),
      stringToHex(args.assetPair, { size: 32 }),
      numberToHex(args.durationSec, { size: 32 }),
      numberToHex(args.startTimestampSec, { size: 32 }),
    ]),
  );
}

/** Align a timestamp (ms) down to the nearest market-start boundary. */
export function floorToMarketStart(nowMs: number): number {
  return Math.floor(nowMs / DURATION_MS) * DURATION_MS;
}

/** Retrieve (or lazily create) the named oracle wallet. */
export function getOracleWallet(context: TaskContext): Promise<IWallet> {
  return context.evm.wallet({ name: ORACLE_WALLET_NAME });
}
