// Manager loop: the leg that makes this a vault rather than a ledger.
//
// Runs a deliberately simple long/flat rotation on a HyperCore perp with a
// slice of NAV, so share price moves from real fills instead of being pinned
// at 1.0. Every order is an IOC that crosses the spread, so a run either fills
// or leaves the vault flat — no resting orders to reconcile.
import type { TaskContext } from "compose";
import {
  closeOpenPosition,
  type CursorRecord,
  type FillRecord,
  formatUsdc,
  getVaultWallet,
  type NavSnapshot,
  type PerpsState,
  type Position,
  readConfig,
  readNav,
  submitIoc,
  totalShares,
  type VaultRecord,
} from "../lib/vault.ts";

interface PerpMeta {
  universe: { name: string; szDecimals: number }[];
}

interface UserFill {
  time: number;
  coin: string;
  side: string;
  sz: string;
  px: string;
  closedPnl: string;
  hash: string;
  tid: number;
}

export async function main(ctx: TaskContext) {
  const config = readConfig(ctx.env);
  const wallet = await getVaultWallet(ctx);
  const positions = await ctx.collection<Position>("positions");
  const snapshots = await ctx.collection<NavSnapshot>("nav_snapshots");
  const vaults = await ctx.collection<VaultRecord>("vault");
  const fills = await ctx.collection<FillRecord>("fills");
  const cursors = await ctx.collection<CursorRecord>("cursors");

  const { nav, accountValue } = await readNav(ctx, config.network, wallet.address, vaults);
  const shares = await totalShares(positions);

  // Note the gate is NOT `nav > 0`: an open position must still be closeable
  // after the last depositor leaves, or it is stranded with nobody to unwind it.
  if (config.tradeEnabled) {
    await runStrategy(ctx, config, wallet, nav, accountValue.spotUsdc, cursors);
  }

  // Re-read after trading so the snapshot reflects the new position value.
  const after = await readNav(ctx, config.network, wallet.address, vaults);
  await recordFills(ctx, config.network, wallet.address, fills, cursors);

  const sharePrice = shares > 0 ? after.nav / shares : 1;
  const snapshot: NavSnapshot = {
    at: Date.now(),
    navUsdc: formatUsdc(after.nav),
    totalShares: formatUsdc(shares),
    sharePrice: formatUsdc(sharePrice),
    accountValueUsdc: formatUsdc(after.accountValue.total),
  };
  await snapshots.setById(String(snapshot.at), snapshot);
  console.log(
    `NAV ${snapshot.navUsdc} | ${snapshot.totalShares} shares | price ${snapshot.sharePrice}`,
  );
  return snapshot;
}

async function runStrategy(
  ctx: TaskContext,
  config: ReturnType<typeof readConfig>,
  wallet: Awaited<ReturnType<typeof getVaultWallet>>,
  nav: number,
  spotUsdc: number,
  cursors: { getById: (id: string) => Promise<CursorRecord | null>; setById: (id: string, doc: CursorRecord) => Promise<void> },
) {
  const perps = await ctx.hypercore.info.clearinghouseState<PerpsState>(
    config.network,
    wallet.address,
  );
  const open = perps.assetPositions.find((p) => p.position.coin === config.strategyCoin);
  const positionSize = Number(open?.position.szi ?? 0);

  const meta = await ctx.hypercore.info<PerpMeta>(config.network, { type: "meta" });
  const assetIndex = meta.universe.findIndex((u) => u.name === config.strategyCoin);
  if (assetIndex < 0) throw new Error(`perp ${config.strategyCoin} not found in meta`);
  const szDecimals = meta.universe[assetIndex].szDecimals;

  const mids = await ctx.hypercore.info.allMids(config.network);
  const mid = Number(mids[config.strategyCoin]);
  if (!mid) throw new Error(`no mid price for ${config.strategyCoin}`);

  if (positionSize !== 0) {
    const openedAt = (await cursors.getById("position_opened"))?.lastTime ?? 0;
    const heldSeconds = (Date.now() - openedAt) / 1000;
    if (heldSeconds < config.strategyHoldSeconds) {
      console.log(`holding ${config.strategyCoin} position for another ${Math.ceil(config.strategyHoldSeconds - heldSeconds)}s`);
      return;
    }
    // Close: flatten via the shared unwind path (also used by redemptions).
    await closeOpenPosition(ctx, config.network, wallet, wallet.address, config.strategyCoin);
    await cursors.setById("position_opened", { id: "position_opened", lastTime: 0 });
    console.log(`closed ${config.strategyCoin} position of ${positionSize}`);
    return;
  }

  // Flat: only open when there is depositor capital to trade.
  if (nav <= 0) return;

  const perpsMargin = Number(perps.withdrawable ?? 0);
  const targetMargin = nav * config.strategyAllocation;
  if (perpsMargin < targetMargin && spotUsdc > 0) {
    const move = Math.min(targetMargin - perpsMargin, spotUsdc);
    if (move >= 1) {
      await ctx.hypercore.transfer.usdClassTransfer(config.network, wallet, {
        amount: formatUsdc(move),
        toPerp: true,
      });
      console.log(`moved ${formatUsdc(move)} USDC into the perps balance for margin`);
    }
  }

  const notional = Math.max(11, targetMargin); // exchange minimum order value is 10 USDC
  const size = Number((notional / mid).toFixed(szDecimals));
  if (size <= 0) {
    console.log(`NAV ${formatUsdc(nav)} too small to open a ${config.strategyCoin} position`);
    return;
  }
  await submitIoc(ctx, config.network, wallet, assetIndex, true, size, mid, szDecimals);
  await cursors.setById("position_opened", { id: "position_opened", lastTime: Date.now() });
  console.log(`opened ${size} ${config.strategyCoin} (~${formatUsdc(notional)} USDC notional)`);
}

/** Pull recent fills into a collection so the UI can show real execution. */
async function recordFills(
  ctx: TaskContext,
  network: "mainnet" | "testnet",
  vaultAddress: string,
  fills: { getById: (id: string) => Promise<FillRecord | null>; setById: (id: string, doc: FillRecord) => Promise<void> },
  cursors: { getById: (id: string) => Promise<CursorRecord | null>; setById: (id: string, doc: CursorRecord) => Promise<void> },
) {
  const cursor = await cursors.getById("fills");
  const startTime = cursor?.lastTime ?? Date.now() - 60 * 60 * 1000;
  const recent = await ctx.hypercore.info<UserFill[]>(network, {
    type: "userFillsByTime",
    user: vaultAddress,
    startTime,
  });
  let latest = startTime;
  for (const fill of recent ?? []) {
    const id = `${fill.hash}-${fill.tid}`;
    if (!(await fills.getById(id))) {
      await fills.setById(id, {
        id,
        at: fill.time,
        coin: fill.coin,
        side: fill.side,
        sz: fill.sz,
        px: fill.px,
        closedPnl: fill.closedPnl,
      });
    }
    latest = Math.max(latest, fill.time);
  }
  await cursors.setById("fills", { id: "fills", lastTime: latest + 1 });
}
