import { TaskContext } from "compose";

import { toScaled18 } from "../lib/scaling";

// ─── Configuration (edit these after deploying the contract) ──────────────

/**
 * Mock custodian endpoint. The default points at this repo's static
 * `mock-custodian.json`, served via GitHub raw. Swap for your own custodian
 * API when you're ready — the response JSON must match CustodianResponse below.
 *
 * Production: prefer an HTTPS endpoint you control. The fetched bundle is
 * written verbatim to on-chain state, so a MITM-vulnerable transport is a
 * data-integrity risk.
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

/**
 * `fetch<T>` is a TypeScript cast — there is no runtime schema validation.
 * A real custodian API can return anything the network lets through. Validate
 * before scaling so misshapen payloads surface as field-level errors instead
 * of cryptic `non-finite value undefined` or `BigInt(NaN)` throws downstream.
 */
function validateBundle(bundle: unknown): asserts bundle is CustodianResponse {
  if (typeof bundle !== "object" || bundle === null) {
    throw new Error("Custodian response is not an object");
  }
  const b = bundle as Record<string, unknown>;
  for (const field of ["cash", "tbills", "repo", "totalNav"] as const) {
    if (typeof b[field] !== "number" || !Number.isFinite(b[field] as number)) {
      throw new Error(`Custodian response field '${field}' is not a finite number (got ${JSON.stringify(b[field])})`);
    }
  }
  if (typeof b.ripcord !== "boolean") {
    throw new Error(`Custodian response field 'ripcord' is not a boolean (got ${JSON.stringify(b.ripcord)})`);
  }
  if (typeof b.asOf !== "string") {
    throw new Error(`Custodian response field 'asOf' is not a string (got ${JSON.stringify(b.asOf)})`);
  }
  const ts = new Date(b.asOf).getTime();
  if (!Number.isFinite(ts)) {
    throw new Error(`Custodian response field 'asOf' is not a parseable ISO 8601 date (got '${b.asOf}')`);
  }
  if (typeof b.accountName !== "string") {
    throw new Error(`Custodian response field 'accountName' is not a string`);
  }
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
  validateBundle(bundle);

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
  // validateBundle has already proven asOf parses, so the BigInt conversion is safe.
  const cash     = toScaled18(bundle.cash);
  const tbills   = toScaled18(bundle.tbills);
  const repo     = toScaled18(bundle.repo);
  const totalNav = toScaled18(bundle.totalNav);
  const asOf     = BigInt(Math.floor(new Date(bundle.asOf).getTime() / 1000));

  const signature = "updateNav(uint256,uint256,uint256,uint256,uint64)";
  const args = [cash, tbills, repo, totalNav, asOf];

  // Publish to both chains independently. allSettled prevents one chain's
  // failure from blocking the other. Note: a partial failure leaves the
  // failed chain one roundId behind; the next cycle will not back-fill the
  // missed round, it just publishes the new one. Multi-chain consumers that
  // compare roundId across chains for liveness will see the divergence.
  const results = await Promise.allSettled([
    wallet.writeContract(evm.chains.baseSepolia,      BASE_SEPOLIA_AGGREGATOR,     signature, args),
    wallet.writeContract(evm.chains.arbitrumSepolia, ARBITRUM_SEPOLIA_AGGREGATOR, signature, args),
  ]);

  const [baseResult, arbResult] = results;

  const summarize = (r: PromiseSettledResult<{ hash: string }>) => {
    if (r.status === "fulfilled") {
      return { ok: true, hash: r.value.hash } as const;
    }
    const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
    return { ok: false, error } as const;
  };

  const baseOut = summarize(baseResult);
  const arbOut  = summarize(arbResult);

  console.log(
    `Published ${bundle.accountName} NAV=$${bundle.totalNav.toLocaleString()} — ` +
    `base:${baseOut.ok ? "ok" : "fail"}, arb:${arbOut.ok ? "ok" : "fail"}`
  );

  // If both chains failed, surface as a task error so compose retries.
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
