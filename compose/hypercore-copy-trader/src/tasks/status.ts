// Read model: wallet address, balances, open positions, recent mirrored fills.
import type { TaskContext } from "compose";

interface SpotState {
  balances: { coin: string; total: string }[];
}

interface PerpsState {
  marginSummary?: { accountValue?: string };
  assetPositions: {
    position: { coin: string; szi: string; entryPx?: string; unrealizedPnl?: string };
  }[];
}

interface MirrorRecord {
  id: string;
  seenAt: number;
}

export async function main(ctx: TaskContext) {
  const { env } = ctx;
  const network = env.HYPERCORE_NETWORK === "mainnet" ? "mainnet" : "testnet";

  const privateKey = env.COPY_TRADER_PRIVATE_KEY;
  if (!privateKey) throw new Error("COPY_TRADER_PRIVATE_KEY secret is not set");
  const wallet = await ctx.evm.wallet({ privateKey, name: "copy-trader", sponsorGas: false });

  const [spot, perps, seen] = await Promise.all([
    ctx.hypercore.info.spotClearinghouseState<SpotState>(network, wallet.address),
    ctx.hypercore.info.clearinghouseState<PerpsState>(network, wallet.address),
    ctx.collection<MirrorRecord>("seen_fills").then((c) => c.findMany({})),
  ]);

  return {
    network,
    wallet: wallet.address,
    spotUsdc: spot.balances.find((b) => b.coin === "USDC")?.total ?? "0",
    perpAccountValue: perps.marginSummary?.accountValue ?? "0",
    positions: perps.assetPositions.map((p) => ({
      coin: p.position.coin,
      size: p.position.szi,
      entryPx: p.position.entryPx,
      unrealizedPnl: p.position.unrealizedPnl,
    })),
    mirroredFillCount: seen.length,
  };
}
