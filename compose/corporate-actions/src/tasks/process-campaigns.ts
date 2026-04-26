import type { TaskContext } from "compose";

import { CHAIN_CONFIG, CONCURRENCY, FINALITY_DEPTH } from "../lib/constants";
import { getHolders, getPipelineHeadBlock } from "../lib/db";
import { proRata } from "../lib/math";
import type { Campaign, Payout } from "../lib/types";

/**
 * Cron trigger (every minute). For each pending/in-progress campaign:
 *   1. Finality gate: wait for the Turbo pipeline to index past
 *      recordBlock + FINALITY_DEPTH so the snapshot can't be reorged.
 *   2. Read current holders from `share_balances` (Postgres, maintained by
 *      Turbo's postgres_aggregate sink).
 *   3. Compute pro-rata payouts.
 *   4. For each holder not yet paid (per on-chain `isPaid`), call `pay()` with
 *      bounded concurrency. Already-paid reverts are no-ops; the contract is
 *      the source of truth.
 *   5. When all holders are paid on-chain, mark the campaign complete.
 */
export async function main(context: TaskContext) {
  const { collection } = context;
  const campaigns = await collection<Campaign>("campaigns");
  const active = await campaigns.findMany({
    status: { $in: ["pending", "in-progress"] },
  });

  for (const campaign of active) {
    await processCampaign(context, campaigns, campaign);
  }
  return { processed: active.length };
}

async function processCampaign(
  context: TaskContext,
  campaigns: Awaited<ReturnType<TaskContext["collection"]>>,
  campaign: Campaign,
) {
  const cfg = CHAIN_CONFIG[campaign.chain];

  // --- Finality gate ---
  const pipelineHead = await getPipelineHeadBlock(campaign.chain);
  const recordBlock = BigInt(campaign.recordBlock);
  const requiredHead = recordBlock + BigInt(FINALITY_DEPTH);
  if (pipelineHead < requiredHead) {
    console.log(
      `[${campaign.userId}/${campaign.chain}] waiting for finality: ` +
        `pipeline=${pipelineHead}, need >=${requiredHead}`,
    );
    return;
  }

  // --- Snapshot holders ---
  const holders = await getHolders(campaign.shareToken, campaign.chain);
  if (holders.length === 0) {
    console.log(
      `[${campaign.userId}/${campaign.chain}] no holders found in share_balances; skipping`,
    );
    return;
  }
  const totalSupply = holders.reduce((s, h) => s + h.balance, 0n);
  const payouts = proRata(holders, BigInt(campaign.totalAmount), totalSupply);

  if (campaign.status === "pending") {
    await campaigns.setById(campaign.rowId, { ...campaign, status: "in-progress" });
  }

  const wallet = await context.evm.wallet({
    name: "corp-actions-operator",
    sponsorGas: true,
  });
  const chainObj = context.evm.chains[campaign.chain];

  // --- Filter to unpaid holders by reading on-chain state ---
  const unpaid: Payout[] = [];
  for (const p of payouts) {
    const isAlreadyPaid = await wallet.readContract(
      chainObj,
      cfg.campaignContract,
      "isPaid(bytes32,address)",
      [campaign.onChainId, p.holder],
    );
    if (!isAlreadyPaid) unpaid.push(p);
  }

  if (unpaid.length === 0) {
    await maybeMarkComplete(context, campaigns, campaign, payouts);
    return;
  }

  // --- Pay with bounded concurrency ---
  for (let i = 0; i < unpaid.length; i += CONCURRENCY) {
    const batch = unpaid.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      batch.map((p) => payOne(wallet, chainObj, cfg, campaign, p)),
    );
  }

  // --- Completion check (re-read on-chain state) ---
  await maybeMarkComplete(context, campaigns, campaign, payouts);
}

async function payOne(
  wallet: Awaited<ReturnType<TaskContext["evm"]["wallet"]>>,
  chainObj: TaskContext["evm"]["chains"][keyof TaskContext["evm"]["chains"]],
  cfg: typeof CHAIN_CONFIG[keyof typeof CHAIN_CONFIG],
  campaign: Campaign,
  { holder, amount, sharesAtSnapshot }: Payout,
) {
  try {
    await wallet.writeContract(
      chainObj,
      cfg.campaignContract,
      "pay(bytes32,address,uint256,uint256)",
      [
        campaign.onChainId,
        holder,
        amount.toString(),
        sharesAtSnapshot.toString(),
      ],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/AlreadyPaid/.test(msg)) {
      // Race with another tx (or recovered restart). Contract guard already
      // enforced correctness; nothing for us to do.
      return;
    }
    if (/AlreadySealed|InsufficientEscrow/.test(msg)) {
      console.log(
        `[${campaign.userId}/${campaign.chain}] terminal pay failure for ${holder}: ${msg}`,
      );
      return;
    }
    console.log(
      `[${campaign.userId}/${campaign.chain}] transient pay failure for ${holder}: ${msg}`,
    );
  }
}

async function maybeMarkComplete(
  _context: TaskContext,
  campaigns: Awaited<ReturnType<TaskContext["collection"]>>,
  campaign: Campaign,
  payouts: Payout[],
) {
  if (campaign.status === "complete") return;

  const wallet = await _context.evm.wallet({
    name: "corp-actions-operator",
    sponsorGas: true,
  });
  const chainObj = _context.evm.chains[campaign.chain];
  const cfg = CHAIN_CONFIG[campaign.chain];

  let stillUnpaid = 0;
  for (const p of payouts) {
    const ok = await wallet.readContract(
      chainObj,
      cfg.campaignContract,
      "isPaid(bytes32,address)",
      [campaign.onChainId, p.holder],
    );
    if (!ok) stillUnpaid++;
  }
  if (stillUnpaid === 0) {
    await campaigns.setById(campaign.rowId, {
      ...campaign,
      status: "complete",
      completedAt: Date.now(),
    });
    console.log(
      `[${campaign.userId}/${campaign.chain}] complete: paid ${payouts.length} holders`,
    );
  }
}
