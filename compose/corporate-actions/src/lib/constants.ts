import type { Hex } from "./types";

/**
 * Single-chain demo on Base Sepolia. Each declaration spawns its own
 * job-mode Turbo pipeline, so there's nothing chain-specific to configure
 * beyond the deployed contract addresses below.
 *
 * Defaults to Base Sepolia so the demo costs no real gas and uses the shared
 * permissionless contracts below (open mint on MockUSDC, open declare() on the
 * campaign). To run on Base mainnet instead, swap in these values (real gas
 * applies):
 *   chain: "base", turboChain: "base",
 *   shareToken:        "0xE05Ceb3E269029E3bab46E35515e8987060D1027",
 *   payToken (MockUSDC): "0x02D9Df62B7AED15739D638B92BAcEA2ce4Cb3d70",
 *   campaignContract:  "0x81051f77ea167b631Dd7F40ac414A9F9344Fb162",
 *   shareTokenDeployBlock: 45654954,
 *
 * Update after running `scripts/deploy.sh`.
 */
export const CONFIG = {
  chain:      "baseSepolia" as const,   // evm.chains[chain] key (camelCase)
  turboChain: "base_sepolia",           // Turbo dataset prefix (snake_case network slug)
  shareToken:       "0x713e0749a9Fe480322990913850e81b0F4F4dc0d" as Hex,
  payToken:         "0x8ec24F07F08745fc3D979336AA81d4Dc73f3D9DE" as Hex,  // MockUSDC (permissionless mint)
  campaignContract: "0xA8e58573B1e10908b63d12B603aCF9C784BF904E" as Hex,  // permissionless: anyone can declare()
  // Block at which `shareToken` was deployed. Job-mode forces
  // `start_at: earliest`, so we can't anchor the source there directly;
  // instead this is used as the lower bound in the snapshot pipeline's
  // SQL filter (`block_number BETWEEN <deploy> AND <record>`), which lets
  // the planner prune all pre-deploy blocks before scanning. Per Jeff: a
  // filter-level block range is meaningfully faster than a source-level
  // `end_block` alone.
  shareTokenDeployBlock: 42275958,
};

/**
 * Concurrent pay() calls. Bounded by the gas-sponsored bundler's throughput
 * (~1-5 userOps/sec/sender). Set high enough that the demo's full
 * 25-holder snapshot fires in a single batch.
 */
export const CONCURRENCY = 25;

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
