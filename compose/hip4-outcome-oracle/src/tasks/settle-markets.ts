// Settles expired HIP-4 markets: reads the perp mark price at (or after)
// expiry and submits settleOutcome with the exact canonical metadata echo.
// Idempotent by registry state — safe to run every minute and to retry.
import type { TaskContext } from "compose";
import { getDeployerWallet, type MarketRow, readConfig } from "../lib/markets.ts";

export async function main(ctx: TaskContext) {
  const config = readConfig(ctx.env);
  const wallet = await getDeployerWallet(ctx);
  const registry = await ctx.collection<MarketRow>("markets");

  const due = await registry.findMany({
    settled: false,
    expiryMs: { $lte: Date.now() },
  });
  if (due.length === 0) {
    return { settled: [] };
  }

  const mids = await ctx.hypercore.info.allMids(config.network);

  const settled: number[] = [];
  for (const market of due) {
    const mark = mids[market.perp];
    if (!mark) {
      console.log(`no mid for perp ${market.perp}; will retry next cycle`);
      continue;
    }

    // Criterion baked into binaryPrice2: YES iff mark price at settlement
    // time is above the threshold.
    const yes = Number(mark) > Number(market.threshold);
    const fraction = yes ? "1" : "0";

    await ctx.hypercore.outcome.settle(config.network, wallet, {
      outcome: market.outcome,
      settleFraction: fraction,
      nameAndDescription: [market.name, market.description],
      sideNames: market.sideNames,
    });

    await registry.setById(String(market.outcome), {
      ...market,
      settled: true,
      settlement: { fraction, markAtExpiry: mark, settledAt: Date.now() },
    });
    settled.push(market.outcome);
    console.log(
      `settled outcome ${market.outcome} ${yes ? "YES" : "NO"} (mark ${mark} vs ${market.threshold})`,
    );
  }

  return { settled };
}
