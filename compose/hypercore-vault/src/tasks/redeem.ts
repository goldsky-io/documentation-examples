// Redemption: the escrow pattern Jeff described — validate off-chain
// conditions, then remit. Funds leave the Compose-managed HyperCore account
// via a user-signed spotSend; shares burn in the ledger.
//
// POST { "depositor": "0x...", "shares": "10" }   (omit shares to redeem all)
import type { TaskContext } from "compose";
import { indexPendingDeposits } from "../lib/deposits.ts";
import {
  closeOpenPosition,
  formatUsdc,
  getVaultWallet,
  type Position,
  readConfig,
  readNav,
  readAccountValue,
  sweepMarginToSpot,
  totalShares,
  type VaultRecord,
} from "../lib/vault.ts";

interface RedeemParams {
  depositor?: string;
  shares?: string;
}

export async function main(ctx: TaskContext, params: RedeemParams) {
  const config = readConfig(ctx.env);
  const wallet = await getVaultWallet(ctx);
  const positions = await ctx.collection<Position>("positions");
  const vaults = await ctx.collection<VaultRecord>("vault");

  const depositor = params.depositor?.toLowerCase();
  if (!depositor || !/^0x[0-9a-f]{40}$/.test(depositor)) {
    throw new Error(`invalid depositor address: ${params.depositor}`);
  }

  const position = await positions.getById(depositor);
  if (!position || Number(position.shares) <= 0) {
    throw new Error(`no position for ${depositor}`);
  }

  // Redeeming more than held is a client error, not a partial fill.
  const requested = params.shares != null ? Number(params.shares) : Number(position.shares);
  if (!(requested > 0)) throw new Error(`invalid share amount: ${params.shares}`);
  if (requested > Number(position.shares)) {
    throw new Error(`requested ${requested} shares, position holds ${position.shares}`);
  }

  // --- Off-chain conditions -------------------------------------------------
  const heldSeconds = (Date.now() - position.lastDepositAt) / 1000;
  if (heldSeconds < config.lockupSeconds) {
    throw new Error(
      `lockup not elapsed: ${Math.ceil(config.lockupSeconds - heldSeconds)}s remaining`,
    );
  }

  // Settle any deposit that has landed but not been credited yet: NAV already
  // includes that capital, so pricing a redemption before crediting it would
  // pay this depositor out of money that belongs to the pending one.
  await indexPendingDeposits(ctx, config, wallet.address);

  const { nav, accountValue } = await readNav(ctx, config.network, wallet.address, vaults);
  const shares = await totalShares(positions);
  let payout = shares > 0 ? (requested / shares) * nav : 0;

  if (payout > config.largeRedemptionUsdc && !config.operatorApprovesLargeRedemptions) {
    throw new Error(
      `redemption of ${formatUsdc(payout)} USDC exceeds the ${config.largeRedemptionUsdc} ` +
        `threshold and operator approval is off`,
    );
  }

  // Payouts leave from the spot balance, but the strategy parks capital as
  // perps margin. A depositor's exit must not depend on the manager's position
  // timing, so unwind exactly as much as the payout needs.
  let spotUsdc = accountValue.spotUsdc;
  if (payout > spotUsdc) {
    const closed = await closeOpenPosition(
      ctx,
      config.network,
      wallet,
      wallet.address,
      config.strategyCoin,
    );
    if (closed) console.log(`closed the ${config.strategyCoin} position to fund a redemption`);
    const swept = await sweepMarginToSpot(
      ctx,
      config.network,
      wallet,
      wallet.address,
      payout - spotUsdc,
    );
    if (swept > 0) console.log(`swept ${formatUsdc(swept)} USDC of margin back to spot`);

    // Unwinding costs spread and fees, which changes NAV. Re-price the exit
    // against the post-unwind NAV so the leaving depositor bears their own
    // exit cost instead of the remaining holders eating it.
    const after = await readNav(ctx, config.network, wallet.address, vaults);
    payout = shares > 0 ? (requested / shares) * after.nav : 0;
    spotUsdc = after.accountValue.spotUsdc;
    console.log(`re-priced payout to ${formatUsdc(payout)} USDC after unwinding`);
  }

  if (payout > spotUsdc) {
    throw new Error(
      `payout ${formatUsdc(payout)} exceeds the liquid balance ` +
        `${formatUsdc(spotUsdc)} available after unwinding the strategy`,
    );
  }
  if (payout <= 0) throw new Error("computed payout is zero");

  // --- Remit ---------------------------------------------------------------
  const amount = formatUsdc(payout);
  const result = await ctx.hypercore.transfer.spotSend(config.network, wallet, {
    destination: depositor,
    token: "USDC:0xeb62eee3685fc4c43992febcd9e75443",
    amount,
  });

  const remaining = Number(position.shares) - requested;
  if (remaining > 0) {
    await positions.setById(depositor, { ...position, shares: formatUsdc(remaining) });
  } else {
    await positions.deleteById(depositor);
  }

  await ctx.logEvent({
    code: "vault.redeem",
    message: `remitted ${amount} USDC to ${depositor}`,
    data: JSON.stringify({ shares: requested, navAtRedemption: formatUsdc(nav) }),
  });
  console.log(`redeemed ${requested} shares -> ${amount} USDC to ${depositor}`);

  return {
    depositor,
    sharesRedeemed: formatUsdc(requested),
    payoutUsdc: amount,
    sharesRemaining: formatUsdc(remaining),
    exchange: result.status,
  };
}
