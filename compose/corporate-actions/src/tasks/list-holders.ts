import type { TaskContext } from "compose";

import { isHexBytes32 } from "../lib/normalize";
import type { Campaign, PersistedPayout } from "../lib/types";

/**
 * HTTP trigger.
 *
 *   POST { "campaignId": "0x<32 bytes hex>" }
 *
 * Returns the persisted holder breakdown for a campaign — address, shares
 * held at snapshot, USDC paid out, and the tx hash that paid them (when
 * available). Used by the dashboard's drill-down view.
 *
 * Source of truth is the `payouts` array stored on the campaign row by
 * the driver before terminalCleanup drops the per-campaign Postgres
 * table; that means the data survives the campaign reaching `complete`.
 */
export async function main(context: TaskContext, params?: { campaignId?: string }) {
  const { collection } = context;
  const userId = params?.campaignId;
  if (!userId || !isHexBytes32(userId)) {
    throw new Error("campaignId must be a 0x-prefixed 32-byte hex string");
  }

  const campaigns = await collection<Campaign>("campaigns");
  const rowId = userId.toLowerCase();
  const campaign = (await campaigns.getById(rowId)) as
    | unknown as Campaign | undefined;
  if (!campaign) {
    return { status: "not-found", holders: [] };
  }

  const holders = (campaign.payouts ?? []).map((p: PersistedPayout) => ({
    holder: p.holder,
    sharesAtSnapshot: p.sharesAtSnapshot,
    amount: p.amount,
    payTxHash: p.payTxHash ?? null,
  }));

  return {
    status: campaign.status,
    onChainId: campaign.onChainId,
    shareToken: campaign.shareToken,
    payToken: campaign.payToken,
    totalAmount: campaign.totalAmount,
    holders,
  };
}
