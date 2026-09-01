import type { TaskContext } from "compose";

const GATED = "0x8B16F85d8D39593a02Efa48C314099C4E719aA1e";

export async function main({ evm, env }: TaskContext) {
  const wallet = await evm.webhookWallet({
    url: env.SIGN_WEBHOOK_URL,
    address: env.WALLET_ADDRESS as `0x${string}`,
    headers: { Authorization: `Bearer ${env.SIGN_WEBHOOK_TOKEN}` },
    name: "turnkey",
  });
  await wallet.writeContract(evm.chains.baseSepolia, GATED, "forbidden()", []);
  return { status: "POLICY_HOLE", detail: "forbidden() was signed and submitted" };
}
