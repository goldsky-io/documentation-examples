import type { Hex } from "./types";

/**
 * Single-chain demo on Base mainnet. Each declaration spawns its own
 * job-mode Turbo pipeline, so there's nothing chain-specific to configure
 * beyond the deployed contract addresses below.
 *
 * Update after running `scripts/deploy.sh`.
 */
export const CONFIG = {
  chain: "base" as const,            // matches evm.chains[chain] AND turbo dataset prefix
  shareToken:       "0xE05Ceb3E269029E3bab46E35515e8987060D1027" as Hex,
  payToken:         "0x02D9Df62B7AED15739D638B92BAcEA2ce4Cb3d70" as Hex,  // MockUSDC
  campaignContract: "0x81051f77ea167b631Dd7F40ac414A9F9344Fb162" as Hex,
  // Block at which `shareToken` was deployed. Job-mode forces
  // `start_at: earliest`, so we can't anchor the source there directly;
  // instead this is used as the lower bound in the snapshot pipeline's
  // SQL filter (`block_number BETWEEN <deploy> AND <record>`), which lets
  // the planner prune all pre-deploy blocks before scanning. Per Jeff: a
  // filter-level block range is meaningfully faster than a source-level
  // `end_block` alone.
  shareTokenDeployBlock: 45654954,
};

/**
 * Concurrent pay() calls. Bounded by the gas-sponsored bundler's throughput
 * (~1-5 userOps/sec/sender). 10 fits the demo's typical 10-holder snapshot
 * in a single batch.
 */
export const CONCURRENCY = 10;

/**
 * State-poll cadence while waiting for the Turbo job-mode snapshot to
 * finish. With Jeff's filter-level block range the snapshot finishes in
 * ~5-10s, so we poll fast (2s) so `declare_campaign` can drive the campaign
 * end-to-end inline before returning.
 */
export const STATE_POLL_INTERVAL_MS = 2_000;

/**
 * Hard cap on snapshot-poll iterations per drive call. Set high so we wait
 * out the snapshot in-line for any realistic case; pathological hangs still
 * eventually fall through to the cron path.
 */
export const MAX_POLLS_PER_TICK = 100;  // 100 × 2s = ~3.3 minutes

/**
 * The Turbo pipeline writes into per-campaign tables to avoid cross-campaign
 * SUM contamination in the `postgres_aggregate` sink.
 *
 *   share_balances_<id>      — agg table (account, balance)
 *   share_transfer_log_<id>  — landing table (truncated per checkpoint)
 *
 * `id` is a 16-char slice of campaignId — stable, unique, fits in Postgres'
 * 63-char identifier limit.
 */
export function pipelineId(campaignId: string): string {
  return campaignId.toLowerCase().replace(/^0x/, "").slice(0, 16);
}

export function pipelineName(campaignId: string): string {
  return `corp-actions-${pipelineId(campaignId)}`;
}

export function aggTableName(campaignId: string): string {
  return `share_balances_${pipelineId(campaignId)}`;
}
