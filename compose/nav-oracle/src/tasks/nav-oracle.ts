import { TaskContext } from "compose";

import { toScaled18 } from "../lib/scaling";

// ─── Configuration (edit these after deploying the contract) ──────────────

/**
 * Mock custodian endpoint. The default points at this repo's static
 * `mock-custodian.json`, served via GitHub raw. Swap for your own custodian
 * API when you're ready — the response JSON must match CustodianResponse below.
 */
const CUSTODIAN_URL =
  "https://raw.githubusercontent.com/goldsky-io/documentation-examples/main/compose/nav-oracle/mock-custodian.json";

/**
 * ReserveAggregator addresses on each chain. Leave as the zero address on
 * first deploy — the task logs a friendly message and skips cleanly. Replace
 * with the real deployed addresses once you've run `goldsky compose wallet
 * create nav-oracle-publisher --env cloud` and deployed the contract via
 * `forge create`.
 */
const BASE_SEPOLIA_AGGREGATOR     = "0x8099A30Ac752f86C77A0e0210085a908ba6d02fE";
const ARBITRUM_SEPOLIA_AGGREGATOR = "0x02D9Df62B7AED15739D638B92BAcEA2ce4Cb3d70";

// ─── Internals ────────────────────────────────────────────────────────────

const PLACEHOLDER_ADDRESS = "0x0000000000000000000000000000000000000000";

interface CustodianResponse {
  accountName: string;
  asOf: string;      // ISO 8601
  cash: number;      // USD
  tbills: number;    // USD
  repo: number;      // USD
  totalNav: number;  // USD
  ripcord: boolean;  // operator kill-switch
}

export async function main(context: TaskContext) {
  const { fetch, evm } = context;

  // Resolve the managed wallet up front. On the very first run this triggers
  // auto-creation, so the publisher address is available before the contracts
  // are deployed (it's the `publisher` constructor arg for ReserveAggregator).
  // sponsorGas: true lets Goldsky pay gas for every write, so the publisher
  // never needs to be funded.
  const wallet = await evm.wallet({
    name: "nav-oracle-publisher",
    sponsorGas: true,
  });

  // First-deploy tolerance: until the operator deploys the contracts and
  // fills in the real addresses at the top of this file, skip cleanly
  // instead of thrashing through retries.
  if (
    BASE_SEPOLIA_AGGREGATOR.toLowerCase()     === PLACEHOLDER_ADDRESS ||
    ARBITRUM_SEPOLIA_AGGREGATOR.toLowerCase() === PLACEHOLDER_ADDRESS
  ) {
    console.log(
      `Publisher wallet ready at ${wallet.address}. Now fund it on both chains, deploy the contracts via forge create, fill in BASE_SEPOLIA_AGGREGATOR and ARBITRUM_SEPOLIA_AGGREGATOR at the top of this file, then redeploy.`
    );
    return { success: true, skipped: "unconfigured", publisherAddress: wallet.address };
  }

  // Fetch the NAV bundle from the custodian. fetch retries transient failures.
  const bundle = await fetch<CustodianResponse>(CUSTODIAN_URL, {
    max_attempts: 3,
    initial_interval_ms: 1000,
    backoff_factor: 2,
  });

  if (!bundle) {
    throw new Error("Custodian fetch returned empty response");
  }

  // Ripcord: the operator has flagged a problem upstream. Do not publish —
  // the next cron run will re-check. This is not an error; returning cleanly
  // prevents compose's retry_config from firing.
  if (bundle.ripcord) {
    console.log(
      `Ripcord engaged for ${bundle.accountName} (asOf ${bundle.asOf}) — skipping publish.`
    );
    return { success: true, skipped: "ripcord", accountName: bundle.accountName };
  }

  // Scale human USD → 18-decimal fixed-point, and ISO timestamp → unix seconds.
  const cash     = toScaled18(bundle.cash);
  const tbills   = toScaled18(bundle.tbills);
  const repo     = toScaled18(bundle.repo);
  const totalNav = toScaled18(bundle.totalNav);
  const asOf     = BigInt(Math.floor(new Date(bundle.asOf).getTime() / 1000));

  const signature = "updateNav(uint256,uint256,uint256,uint256,uint64)";
  const args = [cash, tbills, repo, totalNav, asOf];

  // Publish to both chains independently. allSettled prevents one chain's
  // failure from blocking the other; the next cron cycle reconciles.
  const results = await Promise.allSettled([
    wallet.writeContract(evm.chains.baseSepolia,      BASE_SEPOLIA_AGGREGATOR,     signature, args),
    wallet.writeContract(evm.chains.arbitrumSepolia, ARBITRUM_SEPOLIA_AGGREGATOR, signature, args),
  ]);

  const [baseResult, arbResult] = results;

  const summarize = (r: PromiseSettledResult<{ hash: string }>) =>
    r.status === "fulfilled"
      ? { ok: true,  hash: r.value.hash }
      : { ok: false, error: (r.reason as Error)?.message ?? String(r.reason) };

  const baseOut = summarize(baseResult);
  const arbOut  = summarize(arbResult);

  console.log(
    `Published ${bundle.accountName} NAV=$${bundle.totalNav.toLocaleString()} — ` +
    `base:${baseOut.ok ? "ok" : "fail"}, arb:${arbOut.ok ? "ok" : "fail"}`
  );

  // If both chains failed, surface as a task error so compose retries.
  // Partial failures are tolerated; next cron cycle will catch up.
  if (!baseOut.ok && !arbOut.ok) {
    throw new Error(
      `Both chain writes failed. base: ${baseOut.error}; arb: ${arbOut.error}`
    );
  }

  return {
    success: true,
    accountName: bundle.accountName,
    totalNav: bundle.totalNav,
    asOf: bundle.asOf,
    baseSepolia: baseOut,
    arbitrumSepolia: arbOut,
  };
}
