import type { TaskContext } from "compose";

import { getOracleWallet } from "../lib/utils";

/**
 * Utility task: returns the oracle wallet's address.
 *
 * Use this to discover the address to fund on first deploy:
 *
 *   goldsky compose callTask generate_wallet '{}'
 *
 * Calling this creates the wallet lazily if it doesn't yet exist.
 */
export async function main(context: TaskContext) {
  const oracle = await getOracleWallet(context);
  return {
    address: oracle.address,
    fundingInstructions:
      "Send Base Sepolia ETH to the address above. Coinbase faucet: https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet",
  };
}
