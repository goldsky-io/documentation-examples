// Cron entrypoint for deposit attribution. The logic lives in lib/deposits.ts
// because redemption and the read model must run it too — anything that prices
// against NAV has to settle pending deposits first.
import type { TaskContext } from "compose";
import { indexPendingDeposits } from "../lib/deposits.ts";
import { formatUsdc, getVaultWallet, readConfig } from "../lib/vault.ts";

export async function main(ctx: TaskContext) {
  const config = readConfig(ctx.env);
  const wallet = await getVaultWallet(ctx);
  const result = await indexPendingDeposits(ctx, config, wallet.address);
  return {
    credited: result.credited,
    nav: formatUsdc(result.nav),
    totalShares: formatUsdc(result.totalShares),
  };
}
