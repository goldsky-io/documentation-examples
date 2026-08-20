// Mirror a hypercore.fills row onto HyperCore testnet at MIRROR_RATIO.
//
// Invoked by the Turbo pipeline webhook, one fill row per POST. Errors are
// caught and logged as MIRROR_FAILED so the run succeeds and the pipeline
// advances (mirrors onchain-trigger failure semantics: catch = drop visibly).
import type { TaskContext } from "compose";

interface FillRow {
  id: string;
  user: string;
  coin: string;
  side: string; // "B" buy / "A" sell
  dir?: string;
  price: string | number;
  size: string | number;
  hash?: string;
  trade_id?: string | number;
}

interface PerpMeta {
  universe: { name: string; szDecimals: number }[];
}

interface SeenFill {
  id: string;
  seenAt: number;
}

const MIN_ORDER_NOTIONAL = 10.5; // exchange minimum is ~10 USDC

export async function main(ctx: TaskContext, fill: FillRow) {
  const { env, logEvent } = ctx;
  const network = env.HYPERCORE_NETWORK === "mainnet" ? "mainnet" : "testnet";
  const ratio = Number(env.MIRROR_RATIO ?? "0.001");
  const minFillNotional = Number(env.MIN_FILL_NOTIONAL ?? "10000");
  const maxOrderNotional = Number(env.MAX_ORDER_NOTIONAL ?? "25");
  const allowlist = (env.COIN_ALLOWLIST ?? "").split(",").map((c) => c.trim()).filter(Boolean);

  const skip = async (reason: string, data: Record<string, unknown> = {}) => {
    await logEvent({ code: "MIRROR_SKIPPED", message: reason, data: { fill, ...data } });
    return { mirrored: false, reason };
  };

  // --- Validate the untrusted payload --------------------------------------
  const price = Number(fill?.price);
  const size = Number(fill?.size);
  if (!fill || typeof fill.id !== "string" || !fill.coin || !fill.user) {
    return await skip("malformed fill row");
  }
  if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) {
    return await skip("bad price/size", { price, size });
  }
  if (fill.side !== "B" && fill.side !== "A") {
    return await skip("bad side", { side: fill.side });
  }
  if (allowlist.length > 0 && !allowlist.includes(fill.coin)) {
    return await skip("coin not allowlisted", { coin: fill.coin });
  }
  const fillNotional = price * size;
  if (fillNotional < minFillNotional) {
    return await skip("below min notional", { fillNotional });
  }

  // --- Dedupe (webhook delivery is at-least-once) ---------------------------
  const seen = await ctx.collection<SeenFill>("seen_fills");
  if (await seen.getById(fill.id)) {
    return await skip("duplicate fill id", { id: fill.id });
  }

  // --- Resolve asset index + size decimals (cached in a collection) ---------
  const metaCache = await ctx.collection<{ id: string; assetIndex: number; szDecimals: number }>("asset_meta");
  let meta = await metaCache.getById(fill.coin);
  if (!meta) {
    const perpMeta = await ctx.hypercore.info<PerpMeta>(network, { type: "meta" });
    const assetIndex = perpMeta.universe.findIndex((u) => u.name === fill.coin);
    if (assetIndex < 0) return await skip("coin not on target network", { coin: fill.coin });
    meta = { id: fill.coin, assetIndex, szDecimals: perpMeta.universe[assetIndex].szDecimals };
    await metaCache.setById(fill.coin, meta);
  }

  // --- Size the mirror order against the target network's mid ---------------
  const mids = await ctx.hypercore.info.allMids(network);
  const mid = Number(mids[fill.coin]);
  if (!mid) return await skip("no mid price on target network", { coin: fill.coin });

  let orderNotional = Math.min(size * ratio * mid, maxOrderNotional);
  if (orderNotional < MIN_ORDER_NOTIONAL) orderNotional = MIN_ORDER_NOTIONAL;
  const rawSize = orderNotional / mid;
  const mirrorSize = Number(rawSize.toFixed(meta.szDecimals));
  if (mirrorSize <= 0) return await skip("size rounds to zero", { rawSize, szDecimals: meta.szDecimals });

  // Aggressive IOC limit: cross the spread, 5 significant figures.
  const isBuy = fill.side === "B";
  const aggressive = isBuy ? mid * 1.02 : mid * 0.98;
  const limitPx = Number(Number(aggressive.toPrecision(5)).toFixed(Math.max(0, 6 - meta.szDecimals)));

  const privateKey = env.COPY_TRADER_PRIVATE_KEY;
  if (!privateKey) throw new Error("COPY_TRADER_PRIVATE_KEY secret is not set");
  const wallet = await ctx.evm.wallet({ privateKey, name: "copy-trader", sponsorGas: false });

  // Keep perp margin topped up: sweep spot USDC to perps when margin runs low.
  const perps = await ctx.hypercore.info.clearinghouseState<{ marginSummary?: { accountValue?: string } }>(network, wallet.address);
  if (Number(perps.marginSummary?.accountValue ?? 0) < 20) {
    const spot = await ctx.hypercore.info.spotClearinghouseState<{ balances: { coin: string; total: string }[] }>(network, wallet.address);
    const spotUsdc = Number(spot.balances.find((b) => b.coin === "USDC")?.total ?? 0);
    const move = Math.min(50, Math.floor(spotUsdc));
    if (move >= 5) {
      await ctx.hypercore.transfer.usdClassTransfer(network, wallet, { amount: String(move), toPerp: true });
      await logEvent({ code: "MARGIN_TOPUP", message: `moved ${move} USDC spot -> perps`, data: { move } });
    }
  }

  try {
    const result = await ctx.hypercore.trade.order(network, wallet, {
      orders: [{
        a: meta.assetIndex,
        b: isBuy,
        p: String(limitPx),
        s: String(mirrorSize),
        r: false,
        t: { limit: { tif: "Ioc" } },
      }],
      grouping: "na",
    });

    await seen.setById(fill.id, { id: fill.id, seenAt: Date.now() });
    await logEvent({
      code: "MIRROR_EXECUTED",
      message: `mirrored ${fill.coin} ${isBuy ? "buy" : "sell"} ${mirrorSize} @ ~${limitPx}`,
      data: {
        whale: fill.user,
        coin: fill.coin,
        side: fill.side,
        whaleNotional: fillNotional,
        mirrorSize,
        limitPx,
        orderNotional: mirrorSize * mid,
        fillId: fill.id,
        exchange: result,
      },
    });
    return { mirrored: true, coin: fill.coin, mirrorSize, limitPx };
  } catch (err) {
    await logEvent({
      code: "MIRROR_FAILED",
      message: err instanceof Error ? err.message : String(err),
      data: { fill, mirrorSize, limitPx },
    });
    return { mirrored: false, error: err instanceof Error ? err.message : String(err) };
  }
}
