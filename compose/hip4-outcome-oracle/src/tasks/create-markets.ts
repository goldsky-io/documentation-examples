// Deploys Polymarket-style up/down markets on Hyperliquid HIP-4: for each
// configured perp, a binaryPrice2 outcome whose strike is the current mark
// price ("will X be above its current price at expiry?").
import type { TaskContext } from "compose";
import {
  formatDateTime,
  getDeployerWallet,
  parseDateTime,
  type MarketRow,
  type OutcomeMeta,
  readConfig,
} from "../lib/markets.ts";

// Testnet caps active outcomes per deployer at 10; leave headroom so
// settlement lag never blocks the next create cycle.
const MAX_ACTIVE_MARKETS = 8;

export async function main(ctx: TaskContext) {
  const config = readConfig(ctx.env);
  const wallet = await getDeployerWallet(ctx);
  const registry = await ctx.collection<MarketRow>("markets");

  const active = await registry.findMany({ settled: false });
  if (active.length >= MAX_ACTIVE_MARKETS) {
    console.log(`at capacity (${active.length} active markets), skipping cycle`);
    return { deployed: [], skipped: config.perps };
  }

  const mids = await ctx.hypercore.info.allMids(config.network);

  const deployed: MarketRow[] = [];
  for (const perp of config.perps) {
    const mark = mids[perp];
    if (!mark) {
      console.log(`no mid for perp ${perp}, skipping`);
      continue;
    }

    const expiryMs = Date.now() + config.durationMinutes * 60_000;
    const time = formatDateTime(expiryMs);
    // uDecimal: no sign, exponent, or leading/trailing zeros.
    const threshold = String(Number(mark));

    // Skip if an identical market already exists (idempotency across retries).
    const description = `perp:${perp}|threshold:${threshold}|time:${time}`;
    const existing = await registry.findOne({ description });
    if (existing) {
      console.log(`market already deployed: ${description}`);
      continue;
    }

    await ctx.hypercore.outcome.deploy(config.network, wallet, {
      templateId: "binaryPrice2",
      keywordToValue: { perp, threshold, time },
    });

    // Resolve the assigned outcome index from canonical metadata.
    const meta = await ctx.hypercore.info.outcomeMeta<OutcomeMeta>(config.network);
    const entry = meta.outcomes.find((o) => o.venue === config.venue && o.description === description);
    if (!entry) {
      throw new Error(`deployed market not found in outcomeMeta: ${description}`);
    }

    const row: MarketRow = {
      outcome: entry.outcome,
      name: entry.name,
      description: entry.description,
      sideNames: [entry.sideSpecs[0].name, entry.sideSpecs[1].name],
      perp,
      threshold,
      expiryMs: parseDateTime(time),
      settled: false,
    };
    await registry.setById(String(entry.outcome), row);
    deployed.push(row);
    console.log(`deployed outcome ${entry.outcome}: ${description}`);
  }

  return { deployed: deployed.map((d) => d.outcome) };
}
