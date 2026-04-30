import type { TaskContext } from "compose";

import {
  aggTableName,
  CONCURRENCY,
  CONFIG,
  MAX_POLLS_PER_TICK,
  STATE_POLL_INTERVAL_MS,
} from "../lib/constants";
import { aggTableExists, dropCampaignTables, getHolders } from "../lib/db";
import { proRata } from "../lib/math";
import { deletePipeline, getPipelineState } from "../lib/turbo";
import type { Campaign, Payout } from "../lib/types";

/**
 * Cron trigger.
 *
 * For each non-terminal campaign in the collection:
 *
 *   - status="snapshotting": poll the campaign's job-mode pipeline state every
 *     STATE_POLL_INTERVAL_MS until it transitions to `completed` or `error`.
 *     On `completed` → flip to "paying". On `error` → flip to "failed",
 *     drop the per-campaign tables, delete the pipeline.
 *
 *   - status="paying": read the snapshot from the per-campaign agg table,
 *     compute pro-rata, pay each holder via DistributionCampaign.pay() with
 *     bounded concurrency. The contract's `paid[id][holder]` mapping is the
 *     sole source of truth for "did this holder get paid?" — we re-read that
 *     state on every cron tick, so a pod kill mid-batch is recovered cleanly.
 *     When all on-chain `isPaid` are true → mark complete, delete pipeline,
 *     drop tables.
 *
 *   - status="complete" or "failed": skipped. Terminal.
 */
export async function main(context: TaskContext) {
  const { collection, evm } = context;

  // Eagerly resolve the wallet so its address shows up in idle-tick logs and
  // the Privy provisioning runs once on first invocation.
  const wallet = await evm.wallet({
    name: "corp-actions-operator",
    sponsorGas: true,
  });

  const campaigns = await collection<Campaign>("campaigns");
  const active = await campaigns.findMany({
    status: { $in: ["snapshotting", "paying"] },
  });

  if (active.length === 0) {
    console.log(
      `Operator wallet: ${wallet.address}. No active campaigns; idle.`,
    );
    return { processed: 0, operator: wallet.address };
  }

  for (const campaign of active) {
    try {
      await processCampaign(context, campaigns, campaign);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[${campaign.userId}] tick failed: ${msg}`);
      // Don't mark failed on a transient error — the next tick retries.
    }
  }
  return { processed: active.length, operator: wallet.address };
}

async function processCampaign(
  context: TaskContext,
  campaigns: Awaited<ReturnType<TaskContext["collection"]>>,
  campaign: Campaign,
) {
  if (campaign.status === "snapshotting") {
    await driveSnapshot(context, campaigns, campaign);
    return;
  }
  if (campaign.status === "paying") {
    await drivePayouts(context, campaigns, campaign);
    return;
  }
}

/**
 * Poll the pipeline up to MAX_POLLS_PER_TICK times, sleeping
 * STATE_POLL_INTERVAL_MS between polls. Bounded so we don't sit on a cron
 * tick forever; if the snapshot is genuinely slow, the next tick resumes.
 */
async function driveSnapshot(
  context: TaskContext,
  campaigns: Awaited<ReturnType<TaskContext["collection"]>>,
  campaign: Campaign,
) {
  const aggTable = aggTableName(campaign.userId);

  for (let i = 0; i < MAX_POLLS_PER_TICK; i++) {
    const state = await getPipelineState(context, campaign.pipelineName);

    if (state === "error") {
      await markFailed(
        context,
        campaigns,
        campaign,
        "pipeline entered error state",
      );
      return;
    }

    // Two paths to "snapshot ready":
    //   1. Pipeline reports completed/paused (job-mode terminal states), AND
    //      the per-campaign table exists. Defensive check guards against
    //      a structural failure where Turbo says done but produced no table.
    //   2. Pipeline 404s (auto-cleanup happens ~1h after success but can
    //      also happen sooner) AND the per-campaign table HAS rows in it.
    //      We use row count rather than mere existence because a 404 on a
    //      pipeline that never wrote anything would otherwise silently
    //      flip the campaign to paying.
    const tableExists = await aggTableExists(context, aggTable);
    const sawTerminalState = state === "completed";
    const looksAutoCleaned = state === "unknown" && tableExists;

    if (sawTerminalState && !tableExists) {
      await markFailed(
        context,
        campaigns,
        campaign,
        `pipeline completed but ${aggTable} not found`,
      );
      return;
    }

    if (sawTerminalState || looksAutoCleaned) {
      console.log(`[${campaign.userId}] snapshot completed → paying`);
      await campaigns.setById(campaign.rowId, {
        ...campaign,
        status: "paying",
        snapshotCompletedAt: Date.now(),
      });
      const fresh = await campaigns.getById(campaign.rowId);
      if (fresh) await drivePayouts(context, campaigns, fresh);
      return;
    }

    // running / starting / unknown-without-rows → keep waiting
    if (i < MAX_POLLS_PER_TICK - 1) {
      await sleep(STATE_POLL_INTERVAL_MS);
    }
  }
  console.log(
    `[${campaign.userId}] snapshot still in-flight after ${MAX_POLLS_PER_TICK} polls; ` +
      `will resume next cron tick`,
  );
}

async function drivePayouts(
  context: TaskContext,
  campaigns: Awaited<ReturnType<TaskContext["collection"]>>,
  campaign: Campaign,
) {
  const aggTable = aggTableName(campaign.userId);
  const holders = await getHolders(context, aggTable);
  if (holders.length === 0) {
    // The snapshot completed (the agg table exists) but contains zero rows.
    // For a corporate-action distribution this is always a failure — either
    // the pipeline pod silently failed before writing data, or the operator
    // declared against a token with no holders. Surface it; the operator can
    // recover escrow via DistributionCampaign.seal().
    await markFailed(
      context,
      campaigns,
      campaign,
      "snapshot returned 0 holders (pipeline may have failed to index)",
    );
    return;
  }

  const totalSupply = holders.reduce((s, h) => s + h.balance, 0n);
  const payouts = proRata(holders, BigInt(campaign.totalAmount), totalSupply);

  const wallet = await context.evm.wallet({
    name: "corp-actions-operator",
    sponsorGas: true,
  });
  const chain = context.evm.chains[CONFIG.chain];

  // Filter to unpaid holders by reading on-chain state. The contract is the
  // sole source of truth — if the pod was killed mid-batch on a previous
  // tick, the already-paid holders show up here as paid and we skip them.
  const unpaid: Payout[] = [];
  for (const p of payouts) {
    const isAlreadyPaid = await wallet.readContract(
      chain,
      CONFIG.campaignContract,
      "isPaid(bytes32,address)",
      [campaign.onChainId, p.holder],
    );
    if (!isAlreadyPaid) unpaid.push(p);
  }

  if (unpaid.length === 0) {
    await maybeMarkComplete(context, campaigns, campaign, payouts);
    return;
  }

  // Bounded concurrency. Promise.allSettled so one revert doesn't break the
  // whole batch — the contract's `AlreadyPaid` guard means duplicates are
  // safe even when we're optimistic about parallel state.
  for (let i = 0; i < unpaid.length; i += CONCURRENCY) {
    const batch = unpaid.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map((p) => payOne(wallet, chain, campaign, p)));
  }

  // Re-read on-chain state to decide if we're done.
  await maybeMarkComplete(context, campaigns, campaign, payouts);
}

async function payOne(
  wallet: Awaited<ReturnType<TaskContext["evm"]["wallet"]>>,
  chain: TaskContext["evm"]["chains"][keyof TaskContext["evm"]["chains"]],
  campaign: Campaign,
  { holder, amount, sharesAtSnapshot }: Payout,
) {
  try {
    await wallet.writeContract(
      chain,
      CONFIG.campaignContract,
      "pay(bytes32,address,uint256,uint256)",
      [
        campaign.onChainId,
        holder,
        amount.toString(),
        sharesAtSnapshot.toString(),
      ],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/AlreadyPaid/.test(msg)) return;            // contract guard absorbed a race
    if (/AlreadySealed|InsufficientEscrow/.test(msg)) {
      console.log(`[${campaign.userId}] terminal pay failure for ${holder}: ${msg}`);
      return;
    }
    console.log(`[${campaign.userId}] transient pay failure for ${holder}: ${msg}`);
  }
}

async function maybeMarkComplete(
  context: TaskContext,
  campaigns: Awaited<ReturnType<TaskContext["collection"]>>,
  campaign: Campaign,
  payouts: Payout[],
) {
  if (campaign.status === "complete") return;

  if (payouts.length > 0) {
    const wallet = await context.evm.wallet({
      name: "corp-actions-operator",
      sponsorGas: true,
    });
    const chain = context.evm.chains[CONFIG.chain];
    for (const p of payouts) {
      const ok = await wallet.readContract(
        chain,
        CONFIG.campaignContract,
        "isPaid(bytes32,address)",
        [campaign.onChainId, p.holder],
      );
      if (!ok) return; // not done; next tick will keep paying
    }
  }

  await terminalCleanup(context, campaign);
  await campaigns.setById(campaign.rowId, {
    ...campaign,
    status: "complete",
    completedAt: Date.now(),
  });
  console.log(`[${campaign.userId}] complete: paid ${payouts.length} holders`);
}

async function markFailed(
  context: TaskContext,
  campaigns: Awaited<ReturnType<TaskContext["collection"]>>,
  campaign: Campaign,
  reason: string,
) {
  await terminalCleanup(context, campaign);
  await campaigns.setById(campaign.rowId, {
    ...campaign,
    status: "failed",
    failedAt: Date.now(),
    failureReason: reason,
  });
  console.log(`[${campaign.userId}] failed: ${reason}`);
}

/**
 * Belt-and-suspenders cleanup. Turbo auto-deletes successful job-mode
 * pipelines ~1h after completion, but errored jobs stay around forever
 * unless we DELETE them. We always run both regardless of terminal status
 * so the user's account stays clean across many demo runs.
 *
 * Order matters: DELETE the pipeline first (releases the sink writer's
 * connection), THEN drop the tables.
 */
async function terminalCleanup(context: TaskContext, campaign: Campaign) {
  await deletePipeline(context, campaign.pipelineName).catch(() => {});
  const transfers = aggTableName(campaign.userId);
  await dropCampaignTables(context, transfers).catch(() => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
