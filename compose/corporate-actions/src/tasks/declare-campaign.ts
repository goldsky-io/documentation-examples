import type { TaskContext } from "compose";
import { encodePacked, keccak256 } from "viem";

import { CHAIN_CONFIG } from "../lib/constants";
import { isHexBytes32, normalizeAddr } from "../lib/normalize";
import type { Campaign, ChainKey, DeclareParams, Hex } from "../lib/types";

/**
 * HTTP trigger. POST a corporate-action distribution declaration:
 *
 *   {
 *     "campaignId": "0x<32 bytes hex>",
 *     "chain": "baseSepolia" | "arbitrumSepolia",
 *     "shareToken": "0x...",
 *     "totalAmount": "<USDC amount in 6-decimal base units>"
 *   }
 *
 * Atomically:
 *   1. Approves the campaign contract for `totalAmount` of USDC.
 *   2. Calls DistributionCampaign.declare() — which pulls escrow.
 *   3. Records campaign metadata in the `campaigns` collection.
 *
 * Idempotent on (userId, chain): a duplicate POST returns the existing campaign
 * without a second on-chain transaction.
 */
export async function main(context: TaskContext, params?: DeclareParams) {
  const { evm, collection } = context;
  if (!params) throw new Error("POST body required");

  const userId = params.campaignId;
  if (!isHexBytes32(userId)) {
    throw new Error("campaignId must be a 0x-prefixed 32-byte hex string");
  }
  const chain = params.chain as ChainKey;
  if (!CHAIN_CONFIG[chain]) {
    throw new Error(`unknown chain: ${chain}`);
  }
  const shareToken = normalizeAddr(params.shareToken);
  const totalAmount = BigInt(params.totalAmount);
  if (totalAmount <= 0n) throw new Error("totalAmount must be positive");

  const campaigns = await collection<Campaign>("campaigns", [
    { path: "status", type: "text" },
    { path: "chain", type: "text" },
  ]);

  const rowId = `${userId.toLowerCase()}-${chain}`;
  const existing = await campaigns.getById(rowId);
  if (existing) {
    return { status: "already-declared", campaign: existing };
  }

  const cfg = CHAIN_CONFIG[chain];
  const chainObj = evm.chains[chain];
  const wallet = await evm.wallet({
    name: "corp-actions-operator",
    sponsorGas: true,
  });

  // 1. approve campaign contract for the escrow pull
  await wallet.writeContract(
    chainObj,
    cfg.usdc,
    "approve(address,uint256)",
    [cfg.campaignContract, totalAmount.toString()],
  );

  // 2. declare on-chain. The contract records block.number as the canonical
  //    recordBlock for this campaign; we read it back from the receipt.
  const { hash, receipt } = await wallet.writeContract(
    chainObj,
    cfg.campaignContract,
    "declare(bytes32,address,address,uint256)",
    [userId, cfg.usdc, shareToken, totalAmount.toString()],
  );
  const recordBlock = receipt.blockNumber;

  // canonicalId = keccak256(operator, userId), matching the contract.
  const onChainId = keccak256(
    encodePacked(["address", "bytes32"], [wallet.address, userId as Hex]),
  );

  const campaign: Campaign = {
    rowId,
    userId: userId.toLowerCase() as Hex,
    onChainId,
    chain,
    shareToken,
    payToken: cfg.usdc,
    totalAmount: totalAmount.toString(),
    recordBlock: recordBlock.toString(),
    declareTxHash: hash as Hex,
    status: "pending",
    createdAt: Date.now(),
  };
  await campaigns.setById(rowId, campaign);

  return {
    status: "declared",
    userId: campaign.userId,
    onChainId,
    chain,
    declareTxHash: hash,
  };
}
