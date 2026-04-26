import type { ChainKey } from "./types";

/**
 * Per-chain deploy addresses. Filled in after `forge create` on each chain.
 * Update these constants and redeploy after Phase 1 contract deploys.
 */
export const CHAIN_CONFIG: Record<ChainKey, {
  shareToken: `0x${string}`;
  usdc: `0x${string}`;
  campaignContract: `0x${string}`;
}> = {
  baseSepolia: {
    shareToken:       "0x0000000000000000000000000000000000000000",
    usdc:             "0x0000000000000000000000000000000000000000",
    campaignContract: "0x0000000000000000000000000000000000000000",
  },
  arbitrumSepolia: {
    shareToken:       "0x0000000000000000000000000000000000000000",
    usdc:             "0x0000000000000000000000000000000000000000",
    campaignContract: "0x0000000000000000000000000000000000000000",
  },
};

/**
 * Block-finality depth before compose will start paying out. Must be deep enough
 * that the holder snapshot read from Postgres won't be invalidated by a reorg.
 * 32 is generous on Base/Arb Sepolia (typical reorg depth is ~3 blocks).
 */
export const FINALITY_DEPTH = 32;

/**
 * Concurrent pay() calls per chain. Bounded by the gas-sponsored bundler's
 * throughput (~1-5 userOps/sec/sender). 5 is a safe demo default.
 */
export const CONCURRENCY = 5;
