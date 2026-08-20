// Deposit attribution, shared by every task that prices against NAV.
//
// A deposit hits the account the instant the transfer settles, so NAV moves
// immediately while the shares for it do not exist until this runs. Anything
// that prices against NAV — redemption, the read model — must settle pending
// deposits first, or it values shares against capital nobody has been credited
// for (and a redemption in that window overpays out of other depositors' NAV).
import type { TaskContext } from "compose";
import {
  type CursorRecord,
  type DepositRecord,
  formatUsdc,
  type Position,
  readNav,
  sharesForDeposit,
  totalShares,
  type VaultConfig,
  type VaultRecord,
} from "./vault.ts";

interface LedgerUpdate {
  time: number;
  hash: string;
  delta: {
    type: string;
    token?: string;
    amount?: string;
    user?: string;
    destination?: string;
  };
}

export interface IndexResult {
  credited: number;
  nav: number;
  totalShares: number;
}

export async function indexPendingDeposits(
  ctx: TaskContext,
  config: VaultConfig,
  vaultAddress: string,
): Promise<IndexResult> {
  const address = vaultAddress.toLowerCase();
  const positions = await ctx.collection<Position>("positions");
  const deposits = await ctx.collection<DepositRecord>("deposits");
  const cursors = await ctx.collection<CursorRecord>("cursors");
  const vaults = await ctx.collection<VaultRecord>("vault");

  const cursor = await cursors.getById("deposits");
  if (!cursor) {
    // First run draws the starting line at "now". Transfers that predate the
    // vault are not deposits — crediting account history retroactively would
    // mint shares for money nobody deposited into this vault.
    await cursors.setById("deposits", { id: "deposits", lastTime: Date.now() });
    const { nav } = await readNav(ctx, config.network, address, vaults);
    return { credited: 0, nav, totalShares: await totalShares(positions) };
  }

  const updates = await ctx.hypercore.info<LedgerUpdate[]>(config.network, {
    type: "userNonFundingLedgerUpdates",
    user: address,
    startTime: cursor.lastTime,
  });

  const inbound = (updates ?? []).filter((u: LedgerUpdate) =>
    u.delta.type === "spotTransfer" &&
    u.delta.token === "USDC" &&
    u.delta.destination?.toLowerCase() === address &&
    u.delta.user?.toLowerCase() !== address
  );

  const unprocessed: LedgerUpdate[] = [];
  for (const update of inbound) {
    if (await deposits.getById(update.hash)) continue; // already credited
    unprocessed.push(update);
  }

  // NAV *before* this batch: the deposits have already landed in the account,
  // so back them out before pricing or depositors buy shares with their own money.
  const { nav: navNow } = await readNav(ctx, config.network, address, vaults);
  const batchTotal = unprocessed.reduce((sum, u) => sum + Number(u.delta.amount ?? 0), 0);
  let runningNav = navNow - batchTotal;
  let runningShares = await totalShares(positions);

  let credited = 0;
  for (const update of unprocessed) {
    const depositor = String(update.delta.user).toLowerCase();
    const amount = Number(update.delta.amount ?? 0);
    if (amount < config.minDeposit) {
      console.log(`ignoring dust deposit ${amount} USDC from ${depositor}`);
      continue;
    }

    const minted = sharesForDeposit(amount, runningNav, runningShares);
    const existing = await positions.getById(depositor);
    await positions.setById(depositor, {
      depositor,
      shares: formatUsdc(Number(existing?.shares ?? 0) + minted),
      firstDepositAt: existing?.firstDepositAt ?? update.time,
      lastDepositAt: update.time,
      totalDepositedUsdc: formatUsdc(Number(existing?.totalDepositedUsdc ?? 0) + amount),
    });
    await deposits.setById(update.hash, {
      hash: update.hash,
      depositor,
      amountUsdc: formatUsdc(amount),
      sharesMinted: formatUsdc(minted),
      navBefore: formatUsdc(runningNav),
      at: update.time,
    });

    runningNav += amount;
    runningShares += minted;
    credited += 1;
    await ctx.logEvent({
      code: "vault.deposit",
      message: `credited ${formatUsdc(minted)} shares to ${depositor}`,
      data: JSON.stringify({ hash: update.hash, amount, navBefore: runningNav - amount }),
    });
    console.log(`credited ${formatUsdc(minted)} shares to ${depositor} for ${amount} USDC`);
  }

  const latest = (updates ?? []).reduce(
    (max: number, u: LedgerUpdate) => Math.max(max, u.time),
    cursor.lastTime,
  );
  await cursors.setById("deposits", { id: "deposits", lastTime: latest + 1 });

  return { credited, nav: runningNav, totalShares: runningShares };
}
