/**
 * setup_approvals — HTTP-triggered, run once after funding the wallet
 *
 * Grants USDC + ConditionalTokens approvals to Polymarket's exchange contracts.
 * Required once before the bot can trade. Uses Compose's sponsored gas, so
 * the EOA doesn't need MATIC.
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

export async function main(ctx: TaskContext) {
  const wallet = await ctx.evm.wallet({
    name: "copy-trader",
    privateKey: ctx.env.PRIVATE_KEY as `0x${string}`,
    sponsorGas: true,
  });

  const exchanges = [
    { name: "CTF Exchange", address: CONTRACTS.ctfExchange },
    { name: "NegRisk Exchange", address: CONTRACTS.negRiskExchange },
  ];

  const results: Array<{ name: string; type: string; tx: string }> = [];

  // USDC.e (ERC-20) approvals — let each exchange spend our USDC
  for (const ex of exchanges) {
    console.log(`[setup_approvals] Approving USDC for ${ex.name}`);
    const tx = await wallet.writeContract(
      ctx.evm.chains.polygon,
      CONTRACTS.usdc as `0x${string}`,
      ERC20_APPROVE_ABI,
      [ex.address, MAX_UINT256]
    );
    console.log(`[setup_approvals] USDC approved for ${ex.name}: ${tx.hash}`);
    results.push({ name: ex.name, type: "USDC", tx: tx.hash });
  }

  // ConditionalTokens (ERC-1155) approvals — let each exchange move our share tokens
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
