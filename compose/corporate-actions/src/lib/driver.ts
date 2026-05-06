import type { TaskContext } from "compose";

import {
  aggTableName,
  CONCURRENCY,
  CONFIG,
  MAX_POLLS_PER_TICK,
  STATE_POLL_INTERVAL_MS,
} from "./constants";
import { aggTableRowCount, dropCampaignTables, getHolders } from "./db";
import { proRata } from "./math";
import { deletePipeline, getPipelineState } from "./turbo";
import type { Campaign, Payout } from "./types";

/**
 * Drive a single campaign through the snapshot → paying → complete state
 * machine. Called inline by declare_campaign; can be called repeatedly to
 * resume a stuck campaign.
 *
 *   - status="snapshotting": poll the campaign's job-mode pipeline state at
 *     STATE_POLL_INTERVAL_MS up to MAX_POLLS_PER_TICK iterations until it
 *     transitions to `completed` (or its k8s deployment auto-cleans up
 *     after a successful run, which we infer from `unknown` + agg table
 *     having rows). On `error` → flip to "failed", drop the per-campaign
 *     tables, delete the pipeline.
 *
 *   - status="paying": read the snapshot from the per-campaign agg table,
 *     compute pro-rata, pay each holder via DistributionCampaign.pay() with
 *     bounded concurrency. The contract's `paid[id][holder]` mapping is the
 *     sole source of truth for "did this holder get paid?" — re-read on
 *     every drive call, so a pod kill mid-batch is recovered cleanly.
 *     When `escrowRemaining == 0` → mark complete, delete pipeline,
 *     drop tables.
 *
 *   - status="complete" or "failed": no-op. Terminal.
 */
export async function driveCampaign(
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

    // The Postgres sink commits the table on its FIRST checkpoint — even
    // an empty epoch creates the schema. So we have to count rows, not
    // just check the table exists, or a brief `/state` 404 mid-scan can
    // race the driver into transitioning to `paying` while the pipeline
    // is still scanning ahead of the share token's deploy block.
    //
    // Two paths to "snapshot ready":
    //   1. Pipeline reports completed/paused/stopped AND the table has
    //      ≥1 row.
    //   2. Pipeline state is `unknown` (404 from the auto-cleanup path
    //      that follows a successful job-mode run) AND the table has
    //      ≥1 row.
    //
    // If state is terminal but the table is empty, that's a structural
    // failure (or a token with no holders, which for a corp-action is
    // also operationally a failure).
    const rowCount = await aggTableRowCount(context, aggTable);
    console.log(
      `[${campaign.userId}] poll i=${i} state=${state} rowCount=${rowCount}`,
    );
    const sawTerminalState = state === "completed";

    if (sawTerminalState && (rowCount === null || rowCount === 0)) {
      await markFailed(
        context,
        campaigns,
        campaign,
        `pipeline completed but ${aggTable} has no rows ` +
          `(token may have no transfers, or pipeline failed silently)`,
      );
      return;
    }

    const haveRows = rowCount !== null && rowCount > 0;
    const looksAutoCleaned = state === "unknown" && haveRows;

    if ((sawTerminalState && haveRows) || looksAutoCleaned) {
      console.log(`[${campaign.userId}] snapshot completed → paying`);
      const updated: Campaign = {
        ...campaign,
        status: "paying",
        snapshotCompletedAt: Date.now(),
      };
      await campaigns.setById(campaign.rowId, updated);
      // Don't re-read from the collection here — same Neon pool-stickiness
      // bug we hit on user tables means setById's write may not be visible
      // to an immediate getById on the same connection. We have the new
      // value in-memory; pass it through directly.
      await drivePayouts(context, campaigns, updated);
      return;
    }

    // running / starting / unknown-without-rows → keep waiting
    if (i < MAX_POLLS_PER_TICK - 1) {
      await sleep(STATE_POLL_INTERVAL_MS);
    }
  }
  console.log(
    `[${campaign.userId}] snapshot still in-flight after ${MAX_POLLS_PER_TICK} polls; ` +
      `re-call declare_campaign with the same id to resume`,
  );
}

async function drivePayouts(
  context: TaskContext,
  campaigns: Awaited<ReturnType<TaskContext["collection"]>>,
  campaign: Campaign,
) {
  console.log(`[${campaign.userId}] drivePayouts: start`);
  const aggTable = aggTableName(campaign.userId);
  const holders = await getHolders(context, aggTable);
  console.log(`[${campaign.userId}] drivePayouts: holders=${holders.length}`);
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
  // call, the already-paid holders show up here as paid and we skip them.
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

  console.log(
    `[${campaign.userId}] drivePayouts: unpaid=${unpaid.length}/${payouts.length}`,
  );
  if (unpaid.length === 0) {
    await maybeMarkComplete(context, campaigns, campaign, payouts);
    return;
  }

  // Bounded concurrency. Promise.allSettled so one revert doesn't break the
  // whole batch — the contract's `AlreadyPaid` guard means duplicates are
  // safe even when we're optimistic about parallel state.
  for (let i = 0; i < unpaid.length; i += CONCURRENCY) {
    const batch = unpaid.slice(i, i + CONCURRENCY);
    console.log(`[${campaign.userId}] drivePayouts: sending batch ${batch.length}`);
    await Promise.allSettled(batch.map((p) => payOne(wallet, chain, campaign, p)));
  }

  console.log(`[${campaign.userId}] drivePayouts: batches done, checking escrow`);
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

  // Source of truth for "is this campaign fully distributed" is the
  // contract's `escrowRemaining`. A single read, atomic.
  //
  // The previous implementation looped N `isPaid()` reads instead — which
  // looked correct but had a real failure mode: with sponsored gas + a
  // cluster of pay() txs, individual RPC nodes can return a stale `false`
  // for an isPaid that's actually true on chain. One stale read kept the
  // campaign in `paying` forever and re-fired pay() (silently absorbed by
  // the AlreadyPaid guard, but noisy in operator logs). escrowRemaining=0
  // is a single signal that's already resolved by the contract's
  // checks-effects-interactions on every pay().
  const wallet = await context.evm.wallet({
    name: "corp-actions-operator",
    sponsorGas: true,
  });
  const chain = context.evm.chains[CONFIG.chain];
  const c = await wallet.readContract<
    readonly [
      `0x${string}`, `0x${string}`, `0x${string}`,
      bigint, bigint, bigint,
      boolean, boolean,
    ]
  >(
    chain,
    CONFIG.campaignContract,
    "campaigns(bytes32) view returns (address,address,address,uint256,uint256,uint256,bool,bool)",
    [campaign.onChainId],
  );
  const escrowRemaining = c[4];
  console.log(
    `[${campaign.userId}] maybeMarkComplete: escrowRemaining=${escrowRemaining}`,
  );
  if (escrowRemaining > 0n) return; // not done; caller can re-drive to keep paying

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
