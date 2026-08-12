// Read model for the demo UI: everything about the vault in one call.
import type { TaskContext } from "compose";
import { indexPendingDeposits } from "../lib/deposits.ts";
import {
  type FillRecord,
  formatUsdc,
  getVaultWallet,
  type NavSnapshot,
  type PerpsState,
  type Position,
  readConfig,
  readNav,
  totalShares,
  type VaultRecord,
} from "../lib/vault.ts";

export async function main(ctx: TaskContext) {
  const config = readConfig(ctx.env);
  const wallet = await getVaultWallet(ctx);
  const positionsStore = await ctx.collection<Position>("positions");
  const snapshotStore = await ctx.collection<NavSnapshot>("nav_snapshots");
  const fillStore = await ctx.collection<FillRecord>("fills");
  const vaults = await ctx.collection<VaultRecord>("vault");

  // Credit pending deposits first, otherwise NAV (live from chain) is divided
  // by a stale share count and the UI shows a phantom share-price spike.
  await indexPendingDeposits(ctx, config, wallet.address);

  const { nav, accountValue, vault } = await readNav(
    ctx,
    config.network,
    wallet.address,
    vaults,
  );
  const shares = await totalShares(positionsStore);
  const sharePrice = shares > 0 ? nav / shares : 1;

  const allPositions = await positionsStore.findMany({});
  const allSnapshots = await snapshotStore.findMany({});
  const allFills = await fillStore.findMany({});
  const perps = await ctx.hypercore.info.clearinghouseState<PerpsState>(
    config.network,
    wallet.address,
  );
  const open = perps.assetPositions.find(
    (p: PerpsState["assetPositions"][number]) => p.position.coin === config.strategyCoin,
  );
  const sortedFills = allFills.sort((a: FillRecord, b: FillRecord) => b.at - a.at);

  return {
    vault: {
      name: vault.name,
      network: config.network,
      address: wallet.address,
      baselineUsdc: vault.baselineUsdc,
      initializedAt: vault.initializedAt,
    },
    nav: {
      navUsdc: formatUsdc(nav),
      totalShares: formatUsdc(shares),
      sharePrice: formatUsdc(sharePrice),
      accountValueUsdc: formatUsdc(accountValue.total),
    },
    positions: allPositions.map((p: Position) => ({
      depositor: p.depositor,
      shares: p.shares,
      valueUsdc: formatUsdc(Number(p.shares) * sharePrice),
      totalDepositedUsdc: p.totalDepositedUsdc,
      lastDepositAt: p.lastDepositAt,
    })),
    snapshots: allSnapshots
      .sort((a: NavSnapshot, b: NavSnapshot) => a.at - b.at)
      .slice(-50),
    strategy: {
      enabled: config.tradeEnabled,
      coin: config.strategyCoin,
      positionSzi: open?.position.szi ?? "0",
      entryPx: open?.position.entryPx ?? null,
      unrealizedPnl: open?.position.unrealizedPnl ?? "0",
      realizedPnl: formatUsdc(
        allFills.reduce((sum: number, f: FillRecord) => sum + Number(f.closedPnl), 0),
      ),
      lastFillAt: sortedFills[0]?.at ?? null,
    },
    fills: sortedFills.slice(0, 20),
    config: {
      lockupSeconds: config.lockupSeconds,
      minDeposit: config.minDeposit,
      largeRedemptionUsdc: config.largeRedemptionUsdc,
    },
  };
}
