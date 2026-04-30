/**
 * setup_approvals — HTTP-triggered, run once after funding the wallet
 * (and again after every USDC.e top-up).
 *
 * V2 collateral flow: USDC.e → wrap via Collateral Onramp → pUSD → trade.
 *
 * This task:
 *   1. Approves USDC.e to the Collateral Onramp (one-time, max).
 *   2. Wraps the wallet's full USDC.e balance into pUSD.
 *   3. Approves pUSD to both V2 Exchanges (so they can spend it on BUYs).
 *   4. Approves ConditionalTokens to both V2 Exchanges (for SELLs).
 *
 * Idempotent: re-call any time. Approvals are max so re-approving is a no-op
 * on-chain; wrap() is a no-op when USDC.e balance is zero.
 *
 * Compose sponsors gas, so the EOA doesn't need MATIC.
 *
 * Call: curl -X POST -H "Authorization: Bearer $COMPOSE_TOKEN" \
 *   https://api.goldsky.com/api/admin/compose/v1/copy-trader/tasks/setup_approvals
 */
import type { TaskContext } from "compose";
import { CONTRACTS } from "../lib/types";

const MAX_UINT256 =
  115792089237316195423570985008687907853269984665640564039457584007913129639935n;

const ERC20_APPROVE_ABI = "approve(address,uint256)";
const ERC1155_SET_APPROVAL_ABI = "setApprovalForAll(address,bool)";
const ONRAMP_WRAP_ABI = "wrap(address,address,uint256)";

export async function main(ctx: TaskContext) {
  const pk = ctx.env.PRIVATE_KEY as `0x${string}`;
  const wallet = await ctx.evm.wallet({
    name: "copy-trader",
    privateKey: pk,
    sponsorGas: true,
  });

  const exchanges = [
    { name: "CTF Exchange V2", address: CONTRACTS.ctfExchangeV2 },
    { name: "NegRisk Exchange V2", address: CONTRACTS.negRiskExchangeV2 },
  ];

  const results: Array<{ name: string; type: string; tx: string }> = [];

  // 1. USDC.e (ERC-20) → Collateral Onramp (so it can wrap on our behalf)
  console.log(`[setup_approvals] Approving USDC.e for Collateral Onramp`);
  const usdcApproveTx = await wallet.writeContract(
    ctx.evm.chains.polygon,
    CONTRACTS.usdc as `0x${string}`,
    ERC20_APPROVE_ABI,
    [CONTRACTS.collateralOnramp, MAX_UINT256]
  );
  console.log(`[setup_approvals] USDC.e approved for Onramp: ${usdcApproveTx.hash}`);
  results.push({ name: "Collateral Onramp", type: "USDC.e", tx: usdcApproveTx.hash });

  // 2. Wrap whatever USDC.e the wallet currently holds into pUSD
  const balResp = (await ctx.fetch("https://polygon-bor-rpc.publicnode.com", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_call",
      params: [
        {
          to: CONTRACTS.usdc,
          data: "0x70a08231000000000000000000000000" + wallet.address.slice(2).toLowerCase(),
        },
        "latest",
      ],
      id: 1,
    }),
  })) as { result?: string };
  const usdcBalRaw = balResp?.result ? BigInt(balResp.result) : 0n;
  if (usdcBalRaw > 0n) {
    console.log(`[setup_approvals] Wrapping ${Number(usdcBalRaw) / 1e6} USDC.e → pUSD`);
    const wrapTx = await wallet.writeContract(
      ctx.evm.chains.polygon,
      CONTRACTS.collateralOnramp as `0x${string}`,
      ONRAMP_WRAP_ABI,
      [CONTRACTS.usdc, wallet.address, usdcBalRaw]
    );
    console.log(`[setup_approvals] Wrapped: ${wrapTx.hash}`);
    results.push({ name: "Collateral Onramp", type: "wrap", tx: wrapTx.hash });
  } else {
    console.log(`[setup_approvals] No USDC.e balance to wrap`);
  }

  // 3. pUSD (ERC-20) → V2 Exchanges (so they can spend pUSD on BUYs)
  for (const ex of exchanges) {
    console.log(`[setup_approvals] Approving pUSD for ${ex.name}`);
    const tx = await wallet.writeContract(
      ctx.evm.chains.polygon,
      CONTRACTS.pUSD as `0x${string}`,
      ERC20_APPROVE_ABI,
      [ex.address, MAX_UINT256]
    );
    console.log(`[setup_approvals] pUSD approved for ${ex.name}: ${tx.hash}`);
    results.push({ name: ex.name, type: "pUSD", tx: tx.hash });
  }

  // 4. ConditionalTokens (ERC-1155) → V2 Exchanges (for SELLs and redemption flow)
  for (const ex of exchanges) {
    console.log(`[setup_approvals] Approving ConditionalTokens for ${ex.name}`);
    const tx = await wallet.writeContract(
      ctx.evm.chains.polygon,
      CONTRACTS.conditionalTokens as `0x${string}`,
      ERC1155_SET_APPROVAL_ABI,
      [ex.address, true]
    );
    console.log(`[setup_approvals] ConditionalTokens approved for ${ex.name}: ${tx.hash}`);
    results.push({ name: ex.name, type: "CTF", tx: tx.hash });
  }

  return { success: true, wallet: wallet.address, approvals: results };
}
