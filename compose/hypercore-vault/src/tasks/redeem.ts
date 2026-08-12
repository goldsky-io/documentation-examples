// Redemption: the escrow pattern Jeff described — validate off-chain
// conditions, then remit. Funds leave the Compose-managed HyperCore account
// via a user-signed spotSend; shares burn in the ledger.
//
// POST { "depositor": "0x...", "shares": "10" }   (omit shares to redeem all)
import type { TaskContext } from "compose";
import {
  formatUsdc,
  getVaultWallet,
  type Position,
  readConfig,
  readNav,
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

  const { nav, accountValue } = await readNav(ctx, config.network, wallet.address, vaults);
  const shares = await totalShares(positions);
  const payout = shares > 0 ? (requested / shares) * nav : 0;

  if (payout > config.largeRedemptionUsdc && !config.operatorApprovesLargeRedemptions) {
    throw new Error(
      `redemption of ${formatUsdc(payout)} USDC exceeds the ${config.largeRedemptionUsdc} ` +
        `threshold and operator approval is off`,
    );
  }
  if (payout > nav) {
    throw new Error(`payout ${formatUsdc(payout)} exceeds vault NAV ${formatUsdc(nav)}`);
  }
  // Payouts leave from the spot balance; capital parked as perps margin has to
  // be unwound by the strategy first rather than silently under-paying.
  if (payout > accountValue.spotUsdc) {
    throw new Error(
      `payout ${formatUsdc(payout)} exceeds liquid spot balance ` +
        `${formatUsdc(accountValue.spotUsdc)} — strategy capital must be unwound first`,
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
