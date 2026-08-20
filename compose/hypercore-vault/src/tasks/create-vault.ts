// (Re)initializes the vault: captures a fresh non-vault baseline, clears the
// share ledger, and draws a new starting line for deposit attribution.
//
// "Deploying a vault" here is bookkeeping, not a contract deployment — that is
// the entire point of the pattern. No HyperEVM contract exists.
import type { TaskContext } from "compose";
import {
  type CursorRecord,
  type DepositRecord,
  type FillRecord,
  formatUsdc,
  getVaultWallet,
  type NavSnapshot,
  type Position,
  readAccountValue,
  readConfig,
  type VaultRecord,
} from "../lib/vault.ts";

interface CreateVaultParams {
  name?: string;
}

export async function main(ctx: TaskContext, params: CreateVaultParams) {
  const config = readConfig(ctx.env);
  const wallet = await getVaultWallet(ctx);

  const vaults = await ctx.collection<VaultRecord>("vault");
  const positions = await ctx.collection<Position>("positions");
  const deposits = await ctx.collection<DepositRecord>("deposits");
  const snapshots = await ctx.collection<NavSnapshot>("nav_snapshots");
  const fills = await ctx.collection<FillRecord>("fills");
  const cursors = await ctx.collection<CursorRecord>("cursors");

  // A stale ledger against a fresh baseline would misprice every share.
  // Two Compose collection quirks shape this loop: a collection is created
  // lazily on first write (so dropping a never-written one throws), and a
  // dropped collection's handle cannot be written to again in the same run —
  // hence `cursors` is rewritten below instead of dropped.
  for (const store of [positions, deposits, snapshots, fills]) {
    try {
      await store.drop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("no such table")) throw error;
    }
  }

  const accountValue = await readAccountValue(ctx, config.network, wallet.address);
  const record: VaultRecord = {
    id: "vault",
    name: params.name?.trim() || "HyperCore Vault",
    baselineUsdc: formatUsdc(accountValue.total),
    initializedAt: Date.now(),
  };
  await vaults.setById("vault", record);

  // Deposits only count from now on; account history is not depositor capital.
  const now = Date.now();
  await cursors.setById("deposits", { id: "deposits", lastTime: now });
  await cursors.setById("fills", { id: "fills", lastTime: now });

  await ctx.logEvent({
    code: "vault.created",
    message: `initialized vault "${record.name}"`,
    data: JSON.stringify(record),
  });
  console.log(`vault "${record.name}" initialized; baseline ${record.baselineUsdc} USDC`);

  return {
    vault: {
      name: record.name,
      network: config.network,
      address: wallet.address,
      baselineUsdc: record.baselineUsdc,
      initializedAt: record.initializedAt,
    },
    reset: true,
  };
}
