import type { TaskContext } from "compose";
import { encodePacked, keccak256 } from "viem";

import { CONFIG } from "../lib/constants";
import { driveCampaign } from "../lib/driver";
import { isHexBytes32 } from "../lib/normalize";
import { createSnapshotPipeline } from "../lib/turbo";
import type { Campaign, DeclareParams, Hex } from "../lib/types";

/**
 * HTTP trigger.
 *
 *   POST {
 *     "campaignId":  "0x<32 bytes hex>",  // operator-supplied id, unique per operator
 *     "recordBlock": 24500000,            // snapshot point; must be <= chain head
 *     "totalAmount": "10000000000"        // 10,000 mUSDC (6 decimals)
 *   }
 *
 *   1. Validate `recordBlock` is in the past (or current). Future-dated record
 *      blocks aren't supported in this demo — they're a real corp-action feature
 *      (record dates often look forward) but out of scope here.
 *   2. Approve the campaign contract for `totalAmount` of MockUSDC.
 *   3. Call `DistributionCampaign.declare(...)` — pulls escrow atomically.
 *   4. Spawn a job-mode Turbo pipeline to snapshot holders of `shareToken`
 *      from the share-token deploy block up to `recordBlock`. Per-campaign
 *      sink tables avoid cross-campaign aggregate contamination.
 *   5. Drive the campaign through snapshot → paying → complete inline,
 *      polling the pipeline at STATE_POLL_INTERVAL_MS until done. The
 *      whole lifecycle finishes in this single HTTP request.
 *
 * Idempotent on `campaignId`: a second POST with the same id resumes the
 * existing campaign (drives it forward if non-terminal) instead of
 * re-declaring.
 */
export async function main(context: TaskContext, params?: DeclareParams) {
  const { evm, collection } = context;
  if (!params) throw new Error("POST body required");

  const userId = params.campaignId;
  if (!isHexBytes32(userId)) {
    throw new Error("campaignId must be a 0x-prefixed 32-byte hex string");
  }
  if (typeof params.recordBlock !== "number" || params.recordBlock <= 0) {
    throw new Error("recordBlock must be a positive integer");
  }
  const totalAmount = BigInt(params.totalAmount);
  if (totalAmount <= 0n) throw new Error("totalAmount must be positive");

  const campaigns = await collection<Campaign>("campaigns", [
    { path: "status", type: "text" },
  ]);

  const rowId = userId.toLowerCase();
  const existing = await campaigns.getById(rowId);
  if (existing) {
    // Resume an in-flight campaign — keep driving it forward. Terminal
    // states (complete/failed) just return without doing anything.
    await driveCampaign(context, campaigns, existing);
    const fresh = (await campaigns.getById(rowId)) ?? existing;
    return responseFor(fresh, "resumed");
  }

  // --- recordBlock <= currentBlock ---
  // Resolved against the chain's public RPC via context.fetch (only fetch
  // path that's --allow-net'd in this child process).
  const chain = evm.chains[CONFIG.chain];
  const currentBlock = await getCurrentBlock(context, chain.rpcUrls.default.http[0]);
  const recordBlock = BigInt(params.recordBlock);
  if (recordBlock > currentBlock) {
    throw new Error(
      `recordBlock ${recordBlock} > currentBlock ${currentBlock}; ` +
        `future-dated record blocks are out of scope for this demo`,
    );
  }

  const wallet = await evm.wallet({
    name: "corp-actions-operator",
    sponsorGas: true,
  });

  // --- approve + declare on-chain ---
  await wallet.writeContract(
    chain,
    CONFIG.payToken,
    "approve(address,uint256)",
    [CONFIG.campaignContract, totalAmount.toString()],
  );

  const { hash } = await wallet.writeContract(
    chain,
    CONFIG.campaignContract,
    "declare(bytes32,address,address,uint256)",
    [userId, CONFIG.payToken, CONFIG.shareToken, totalAmount.toString()],
  );

  // canonicalId matches the contract's keccak256(operator, userId).
  const onChainId = keccak256(
    encodePacked(["address", "bytes32"], [wallet.address, userId as Hex]),
  );

  // --- spawn the snapshot pipeline ---
  // If this fails AFTER declare(), the operator can recover escrow with
  // DistributionCampaign.seal(). The campaign row is not written, so
  // there's nothing to drive forward.
  const pipeline = await createSnapshotPipeline(context, {
    campaignId: userId,
    shareToken: CONFIG.shareToken,
    recordBlock,
  });

  const campaign: Campaign = {
    rowId,
    userId: rowId as Hex,
    onChainId,
    shareToken: CONFIG.shareToken,
    payToken: CONFIG.payToken,
    totalAmount: totalAmount.toString(),
    recordBlock: recordBlock.toString(),
    declareTxHash: hash as Hex,
    pipelineName: pipeline.name,
    status: "snapshotting",
    createdAt: Date.now(),
  };
  await campaigns.setById(rowId, campaign);

  // Drive the campaign through snapshot → paying → complete inline. If
  // anything throws, the partial state is preserved and the operator can
  // re-POST the same campaignId to resume. Re-throw to surface failure.
  await driveCampaign(context, campaigns, campaign);
  const final = (await campaigns.getById(rowId)) ?? campaign;
  return responseFor(final, "declared");
}

function responseFor(c: Campaign, source: "declared" | "resumed") {
  return {
    status: c.status,
    source,
    userId: c.userId,
    onChainId: c.onChainId,
    pipelineName: c.pipelineName,
    declareTxHash: c.declareTxHash,
    failureReason: c.status === "failed" ? c.failureReason : undefined,
  };
}

async function getCurrentBlock(
  ctx: TaskContext,
  rpcUrl: string,
): Promise<bigint> {
  const res = await ctx.fetch<{ result?: string; error?: { message: string } }>(
    rpcUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
    },
  );
  if (res?.error) throw new Error(`eth_blockNumber: ${res.error.message}`);
  if (!res?.result) throw new Error("eth_blockNumber returned no result");
  return BigInt(res.result);
}
