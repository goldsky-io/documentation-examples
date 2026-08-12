// Shared vault helpers: config, ledger shapes, NAV, and share math.
import type { TaskContext } from "compose";

export type HypercoreNetwork = "mainnet" | "testnet";

export interface VaultConfig {
  network: HypercoreNetwork;
  minDeposit: number;
  lockupSeconds: number;
  largeRedemptionUsdc: number;
  operatorApprovesLargeRedemptions: boolean;
  tradeEnabled: boolean;
  strategyCoin: string;
  /** Fraction of NAV the strategy is allowed to put at risk. */
  strategyAllocation: number;
  /** Close and re-open the position after this many seconds in a trade. */
  strategyHoldSeconds: number;
}

/** One depositor's position. Id = lowercased depositor address. */
export interface Position {
  depositor: string;
  shares: string;
  firstDepositAt: number;
  lastDepositAt: number;
  totalDepositedUsdc: string;
}

/** Processed deposit, keyed by the HyperCore transfer hash (dedupe). */
export interface DepositRecord {
  hash: string;
  depositor: string;
  amountUsdc: string;
  sharesMinted: string;
  navBefore: string;
  at: number;
}

export interface CursorRecord {
  id: string;
  lastTime: number;
}

/**
 * Capital in the account that does NOT belong to depositors, captured when the
 * vault is initialized. The vault account may also hold operator funds, so NAV
 * must be account value minus this baseline — otherwise the first depositor's
 * shares are priced against money they don't own and redemption drains the
 * account.
 */
export interface VaultRecord {
  id: "vault";
  name: string;
  baselineUsdc: string;
  initializedAt: number;
}

export interface NavSnapshot {
  at: number;
  navUsdc: string;
  totalShares: string;
  sharePrice: string;
  accountValueUsdc: string;
}

export interface FillRecord {
  id: string;
  at: number;
  coin: string;
  side: string;
  sz: string;
  px: string;
  closedPnl: string;
}

export function readConfig(env: Record<string, string>): VaultConfig {
  const network = env.HYPERCORE_NETWORK === "mainnet" ? "mainnet" : "testnet";
  return {
    network,
    minDeposit: Number(env.MIN_DEPOSIT ?? "1"),
    lockupSeconds: Number(env.LOCKUP_SECONDS ?? "60"),
    largeRedemptionUsdc: Number(env.LARGE_REDEMPTION_USDC ?? "1000"),
    operatorApprovesLargeRedemptions: env.OPERATOR_APPROVES_LARGE_REDEMPTIONS === "true",
    tradeEnabled: env.TRADE_ENABLED === "true",
    strategyCoin: env.STRATEGY_COIN ?? "BTC",
    strategyAllocation: Number(env.STRATEGY_ALLOCATION ?? "0.5"),
    strategyHoldSeconds: Number(env.STRATEGY_HOLD_SECONDS ?? "300"),
  };
}

export async function getVaultWallet(ctx: TaskContext) {
  const privateKey = ctx.env.VAULT_PRIVATE_KEY;
  if (!privateKey) throw new Error("VAULT_PRIVATE_KEY secret is not set");
  return await ctx.evm.wallet({ privateKey, name: "hypercore-vault", sponsorGas: false });
}

interface SpotState {
  balances: { coin: string; total: string }[];
}

export interface PerpsState {
  marginSummary: { accountValue: string };
  withdrawable: string;
  assetPositions: {
    position: {
      coin: string;
      szi: string;
      entryPx: string | null;
      unrealizedPnl: string;
      positionValue: string;
    };
  }[];
}

export interface AccountValue {
  spotUsdc: number;
  perpsAccountValue: number;
  total: number;
}

/**
 * Everything the vault account is worth: spot USDC plus perps account value
 * (margin + unrealized PnL). Trading moves value between the two, so NAV must
 * span both or a deposit-then-trade sequence looks like a loss.
 */
export async function readAccountValue(
  ctx: TaskContext,
  network: HypercoreNetwork,
  vaultAddress: string,
): Promise<AccountValue> {
  const [spot, perps] = await Promise.all([
    ctx.hypercore.info.spotClearinghouseState<SpotState>(network, vaultAddress),
    ctx.hypercore.info.clearinghouseState<PerpsState>(network, vaultAddress),
  ]);
  const spotUsdc = Number(spot.balances.find((b: { coin: string }) => b.coin === "USDC")?.total ?? 0);
  const perpsAccountValue = Number(perps.marginSummary?.accountValue ?? 0);
  return { spotUsdc, perpsAccountValue, total: spotUsdc + perpsAccountValue };
}

interface VaultStore {
  getById: (id: string) => Promise<VaultRecord | null>;
  setById: (id: string, doc: VaultRecord) => Promise<void>;
}

/** The vault record, created on first use with the current account value as baseline. */
export async function ensureVault(
  ctx: TaskContext,
  network: HypercoreNetwork,
  vaultAddress: string,
  vaults: VaultStore,
  name = "HyperCore Vault",
): Promise<VaultRecord> {
  const existing = await vaults.getById("vault");
  if (existing) return existing;
  const value = await readAccountValue(ctx, network, vaultAddress);
  const record: VaultRecord = {
    id: "vault",
    name,
    baselineUsdc: formatUsdc(value.total),
    initializedAt: Date.now(),
  };
  await vaults.setById("vault", record);
  console.log(`initialized vault "${name}" with non-vault baseline ${record.baselineUsdc} USDC`);
  return record;
}

/**
 * Net asset value: account value minus the non-vault baseline, so NAV is
 * depositor capital plus strategy P&L on it — never the operator's float.
 */
export async function readNav(
  ctx: TaskContext,
  network: HypercoreNetwork,
  vaultAddress: string,
  vaults: VaultStore,
): Promise<{ nav: number; accountValue: AccountValue; vault: VaultRecord }> {
  const vault = await ensureVault(ctx, network, vaultAddress, vaults);
  const accountValue = await readAccountValue(ctx, network, vaultAddress);
  return {
    nav: Math.max(0, accountValue.total - Number(vault.baselineUsdc)),
    accountValue,
    vault,
  };
}

export async function totalShares(
  positions: { findMany: (f: Record<string, unknown>) => Promise<Position[]> },
): Promise<number> {
  const all = await positions.findMany({});
  return all.reduce((sum: number, p: Position) => sum + Number(p.shares), 0);
}

/**
 * Shares minted for a deposit. First money in gets 1 share per USDC; later
 * deposits are priced against NAV *before* the deposit landed, so existing
 * holders keep their claim on strategy gains.
 */
export function sharesForDeposit(
  amountUsdc: number,
  navBeforeUsdc: number,
  existingShares: number,
): number {
  if (existingShares <= 0 || navBeforeUsdc <= 0) return amountUsdc;
  return amountUsdc * (existingShares / navBeforeUsdc);
}

/** USDC amount formatted for HyperCore transfer actions (6dp, no trailing zeros). */
export function formatUsdc(amount: number): string {
  return String(Number(amount.toFixed(6)));
}
