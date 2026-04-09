import { TaskContext } from "compose";

/**
 * Generate the Compose wallet and output its address
 *
 * Run this before deploying your contract to get the fulfiller address:
 *   goldsky compose callTask generate_wallet '{}'
 */
export async function main(context: TaskContext) {
  const { evm } = context;

  const wallet = await evm.wallet({ name: "randomness-fulfiller" });

  return {
    address: wallet.address,
    name: wallet.name,
    message: "Use this address as the fulfiller when deploying your contract",
  };
}
