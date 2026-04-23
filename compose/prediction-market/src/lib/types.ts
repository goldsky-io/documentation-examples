import type { Hex } from "viem";

export type Outcome = "UP" | "DOWN";

export type Market = {
  questionId: Hex;
  assetPair: "BTC_USD";
  durationSec: number;
  startTime: number; // ms unix
  endTime: number;   // ms unix = startTime + DURATION_MS
  openPrice: number; // USD
  closePrice?: number;
  resolved: boolean;
  outcome?: Outcome;
  prepareConditionTxHash: string | null;
  reportPayoutsTxHash?: string;
};
