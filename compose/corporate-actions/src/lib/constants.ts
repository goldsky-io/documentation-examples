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
    shareToken:       "0x2d134178F9efC772A93BB83632965E6b731e1E19",
    usdc:             "0xba71286Ce2792A955C65c09918C08a0cDfF171FE",
    campaignContract: "0xB7c84e9e20F894e02493e27558d030dD3AEC0576",
  },
  arbitrumSepolia: {
    shareToken:       "0x81051f77ea167b631Dd7F40ac414A9F9344Fb162",
    usdc:             "0x6320a7b21965430d783Eedda5743824f1B5Ce2Ed",
    campaignContract: "0x801a153c4811235F10A69836F4eD0EcA76F2E693",
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
