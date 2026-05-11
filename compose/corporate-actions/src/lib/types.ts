export type Hex = `0x${string}`;

/**
 * Campaign lifecycle:
 *
 *   snapshotting → paying → complete
 *                  ↘ failed
 *
 *   - snapshotting: a job-mode Turbo pipeline is running, indexing Transfer
 *     events of `shareToken` from chain genesis up to `recordBlock`.
 *   - paying: the pipeline has emitted the snapshot to Postgres; the cron is
 *     pro-rata paying out per holder.
 *   - complete: every holder is paid on-chain. Pipeline has been deleted.
 *   - failed: the pipeline errored. Pipeline has been deleted; the campaign
 *     row stays around for postmortem (escrow can be recovered via
 *     `DistributionCampaign.seal()`).
 */
export type CampaignStatus = "snapshotting" | "paying" | "complete" | "failed";

export interface DeclareParams {
  campaignId: string;   // bytes32 hex string — operator-supplied id
  recordBlock: number;  // snapshot point; must be <= chain head at declare time
  totalAmount: string;  // bigint as string (USDC has 6 decimals)
}

export interface Campaign {
  rowId: string;            // = userId (lowercased) — collection unique key
  userId: Hex;              // operator-supplied campaignId, lowercased
  onChainId: Hex;           // keccak256(operator, userId)
  shareToken: Hex;          // resolved server-side from constants
  payToken: Hex;            // resolved server-side (MockUSDC)
  totalAmount: string;
  recordBlock: string;      // snapshot block, recorded both on-chain and here
  declareTxHash: Hex;
  pipelineName: string;     // unique per campaign; used for /state polls and DELETE
  status: CampaignStatus;
  createdAt: number;
  snapshotCompletedAt?: number;
  completedAt?: number;
  failedAt?: number;
  failureReason?: string;
  // Persisted payouts so the holder/amount table survives terminalCleanup
  // (which drops the per-campaign Postgres tables). Populated when the
  // driver transitions to "paying" and the pro-rata is computed; bigints
  // serialised as decimal strings so the row round-trips through JSON.
  payouts?: PersistedPayout[];
}

export interface PersistedPayout {
  holder: Hex;
  sharesAtSnapshot: string;  // bigint as text
  amount: string;            // bigint as text (USDC, 6 decimals)
  payTxHash?: Hex;           // captured per-batch in drivePayouts
}

export interface Holder {
  address: Hex;
  balance: bigint;
}

export interface Payout {
  holder: Hex;
  amount: bigint;
  sharesAtSnapshot: bigint;
}
