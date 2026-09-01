import type { TaskContext } from "compose";

const GATED = "0x8B16F85d8D39593a02Efa48C314099C4E719aA1e";
const EXPLORER = "https://sepolia.basescan.org/tx/";

export async function main({ evm, env }: TaskContext) {
  const wallet = await evm.webhookWallet({
    url: env.SIGN_WEBHOOK_URL,
    address: env.WALLET_ADDRESS as `0x${string}`,
    headers: { Authorization: `Bearer ${env.SIGN_WEBHOOK_TOKEN}` },
    name: "fireblocks",
  });
  const chain = evm.chains.baseSepolia;
  const before = await wallet.readContract(chain, GATED, "pings()", []);
  const tx = await wallet.writeContract(chain, GATED, "ping()", []);
  const after = await wallet.readContract(chain, GATED, "pings()", []);
  return {
    status: "completed",
    transactionHash: tx.hash,
    userOpHash: tx.userOpHash,
    explorer: EXPLORER + tx.hash,
    pingsBefore: String(before),
    pingsAfter: String(after),
  };
}
