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
  shareToken:       "0x6320a7b21965430d783Eedda5743824f1B5Ce2Ed" as Hex,
  payToken:         "0x02D9Df62B7AED15739D638B92BAcEA2ce4Cb3d70" as Hex,  // MockUSDC
  campaignContract: "0x81051f77ea167b631Dd7F40ac414A9F9344Fb162" as Hex,
  // Block at which `shareToken` was deployed. The pipeline's `start_at` is
  // anchored here so the backfill skips the millions of pre-deploy blocks
  // that can't possibly contain Transfer events for this token. Without
  // this, snapshot pipelines on Base take 5-10 minutes; with it they
  // complete in seconds (Fast Scan still applies on top via the address
  // filter).
  shareTokenDeployBlock: 45363717,
};

/**
 * Concurrent pay() calls. Bounded by the gas-sponsored bundler's throughput
 * (~1-5 userOps/sec/sender). 5 is a safe demo default.
 */
export const CONCURRENCY = 5;

/**
 * State-poll cadence inside a single cron tick while waiting for the Turbo
 * job-mode snapshot to finish. Snappy for the demo; cheap (proxied call).
 */
export const STATE_POLL_INTERVAL_MS = 5_000;

/**
 * Hard cap on per-tick state polling so we don't hold a cron tick forever.
 * Sized to fit comfortably inside the cron's 1-minute boundary; if the
 * snapshot is genuinely slower, the next tick resumes polling.
 */
export const MAX_POLLS_PER_TICK = 10;  // 10 × 5s = 50 seconds

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
