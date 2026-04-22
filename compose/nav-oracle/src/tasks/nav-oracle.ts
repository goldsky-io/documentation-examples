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
const BASE_SEPOLIA_AGGREGATOR     = "0x0000000000000000000000000000000000000000";
const ARBITRUM_SEPOLIA_AGGREGATOR = "0x0000000000000000000000000000000000000000";

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

  // First-deploy tolerance: until the operator runs `wallet create`, deploys
  // the contracts, and fills in the real addresses at the top of this file,
  // skip cleanly instead of thrashing through retries.
  if (
    BASE_SEPOLIA_AGGREGATOR.toLowerCase()     === PLACEHOLDER_ADDRESS ||
    ARBITRUM_SEPOLIA_AGGREGATOR.toLowerCase() === PLACEHOLDER_ADDRESS
  ) {
    console.log(
      "Contract addresses not yet configured — run `goldsky compose wallet create`, deploy the contracts via forge create, fill in BASE_SEPOLIA_AGGREGATOR and ARBITRUM_SEPOLIA_AGGREGATOR at the top of this file, then redeploy."
    );
    return { success: true, skipped: "unconfigured" };
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
  // The generated contract class expects stringified big numbers.
  const cash     = toScaled18(bundle.cash).toString();
  const tbills   = toScaled18(bundle.tbills).toString();
  const repo     = toScaled18(bundle.repo).toString();
  const totalNav = toScaled18(bundle.totalNav).toString();
  const asOf     = Math.floor(new Date(bundle.asOf).getTime() / 1000).toString();

  const wallet = await evm.wallet({ name: "nav-oracle-publisher" });

  const baseAggregator = new evm.contracts.ReserveAggregator(
    BASE_SEPOLIA_AGGREGATOR,
    evm.chains.baseSepolia,
    wallet
  );
  const arbAggregator = new evm.contracts.ReserveAggregator(
    ARBITRUM_SEPOLIA_AGGREGATOR,
    evm.chains.arbitrumSepolia,
    wallet
  );

  // Publish to both chains independently. allSettled prevents one chain's
  // failure from blocking the other; the next cron cycle reconciles.
  const results = await Promise.allSettled([
    baseAggregator.updateNav(cash, tbills, repo, totalNav, asOf),
    arbAggregator.updateNav(cash, tbills, repo, totalNav, asOf),
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
