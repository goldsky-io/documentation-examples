// Attributes inbound USDC transfers to depositors and mints NAV-priced shares.
// Replaces what a HyperCore vault would do internally: the ledger lives in a
// Compose collection, the funds live in the Compose-managed HyperCore account.
import type { TaskContext } from "compose";
import {
  type CursorRecord,
  type DepositRecord,
  formatUsdc,
  getVaultWallet,
  type Position,
  readConfig,
  readNav,
  sharesForDeposit,
  totalShares,
  type VaultRecord,
} from "../lib/vault.ts";

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

export async function main(ctx: TaskContext) {
  const config = readConfig(ctx.env);
  const wallet = await getVaultWallet(ctx);
  const vaultAddress = wallet.address.toLowerCase();

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
    console.log("initialized deposit cursor; only transfers from now on are deposits");
    return { credited: 0, initialized: true };
  }
  const startTime = cursor.lastTime;

  const updates = await ctx.hypercore.info<LedgerUpdate[]>(config.network, {
    type: "userNonFundingLedgerUpdates",
    user: vaultAddress,
    startTime,
  });

  const inbound = (updates ?? []).filter((u: LedgerUpdate) =>
    u.delta.type === "spotTransfer" &&
    u.delta.token === "USDC" &&
    u.delta.destination?.toLowerCase() === vaultAddress &&
    u.delta.user?.toLowerCase() !== vaultAddress
  );

  // NAV *before* this batch: current balance minus everything we are about to
  // credit, so share pricing isn't diluted by the deposits themselves.
  const { nav: navNow } = await readNav(ctx, config.network, vaultAddress, vaults);
  const unprocessed: LedgerUpdate[] = [];
  for (const update of inbound) {
    if (await deposits.getById(update.hash)) continue; // already credited
    unprocessed.push(update);
  }
  const batchTotal = unprocessed.reduce((sum, u) => sum + Number(u.delta.amount ?? 0), 0);
  let runningNav = navNow - batchTotal;
  let runningShares = await totalShares(positions);

  const credited: string[] = [];
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
    credited.push(`${depositor} +${formatUsdc(minted)} shares for ${amount} USDC`);
    await ctx.logEvent({
      code: "vault.deposit",
      message: `credited ${formatUsdc(minted)} shares to ${depositor}`,
      data: JSON.stringify({ hash: update.hash, amount, navBefore: runningNav - amount }),
    });
  }

  const latest = (updates ?? []).reduce((max: number, u: LedgerUpdate) => Math.max(max, u.time), startTime);
  await cursors.setById("deposits", { id: "deposits", lastTime: latest + 1 });

  if (credited.length) console.log(credited.join("; "));
  return { credited: credited.length, nav: formatUsdc(runningNav), totalShares: formatUsdc(runningShares) };
}
