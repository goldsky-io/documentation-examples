import { TaskContext } from "compose";
import { WALLET_NAMES } from "../lib/constants.ts";

/**
 * Generate Compose wallets and output their addresses
 *
 * Run this before deploying your contract to get the wallet addresses:
 *   goldsky compose callTask generate_wallet '{}'
 */
export async function main(context: TaskContext) {
  const [requester, fulfiller] = await Promise.all([
    context.evm.wallet({ name: WALLET_NAMES.REQUESTER }),
    context.evm.wallet({ name: WALLET_NAMES.FULFILLER }),
  ]);

  return {
    requester: { address: requester.address, name: requester.name },
    fulfiller: { address: fulfiller.address, name: fulfiller.name },
    message:
      "Use the fulfiller address when deploying your contract, and fund the requester to make randomness requests",
  };
}
