// Shared helpers for the HIP-4 oracle tasks.
import type { TaskContext } from "compose";

export interface MarketRow {
  /** Outcome index assigned by HyperCore at deployment. */
  outcome: number;
  /** Canonical name, e.g. "template:binaryPrice2" (echoed at settlement). */
  name: string;
  /** Canonical description, e.g. "perp:BTC|threshold:64000|time:20260810-1857". */
  description: string;
  /** Canonical side names, [YES, NO] (echoed at settlement). */
  sideNames: [string, string];
  perp: string;
  threshold: string;
  /** Settlement time in ms since epoch. */
  expiryMs: number;
  settled: boolean;
  /** Set at settlement for the audit trail. */
  settlement?: { fraction: string; markAtExpiry: string; settledAt: number };
}

export interface OutcomeMeta {
  outcomes: {
    outcome: number;
    name: string;
    description: string;
    sideSpecs: { name: string }[];
    venue?: string;
  }[];
}

export type HypercoreNetwork = "mainnet" | "testnet";

export interface OracleConfig {
  network: HypercoreNetwork;
  venue: string;
  perps: string[];
  durationMinutes: number;
}

export function readConfig(env: Record<string, string>): OracleConfig {
  const network = env.HYPERCORE_NETWORK === "mainnet" ? "mainnet" : "testnet";
  const perps = (env.PERPS ?? "BTC").split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  const durationMinutes = Number(env.MARKET_DURATION_MINUTES ?? "30");
  if (!Number.isFinite(durationMinutes) || durationMinutes < 5) {
    throw new Error(`MARKET_DURATION_MINUTES must be >= 5, got ${env.MARKET_DURATION_MINUTES}`);
  }
  return { network, venue: env.VENUE ?? "", perps, durationMinutes };
}

/** Format a ms timestamp as the template dateTime hint: %Y%m%d-%H%M (UTC). */
export function formatDateTime(ms: number): string {
  const t = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}-${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}`;
}

/** Parse the template dateTime back to ms since epoch (UTC). */
export function parseDateTime(value: string): number {
  return Date.UTC(
    Number(value.slice(0, 4)),
    Number(value.slice(4, 6)) - 1,
    Number(value.slice(6, 8)),
    Number(value.slice(9, 11)),
    Number(value.slice(11, 13)),
  );
}

export async function getDeployerWallet(ctx: TaskContext) {
  const privateKey = ctx.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) throw new Error("DEPLOYER_PRIVATE_KEY secret is not set");
  return await ctx.evm.wallet({ privateKey, name: "hip4-deployer", sponsorGas: false });
}
