import type { TaskContext } from "compose";

import { getOracleWallet } from "../lib/utils";

/**
 * Utility task: returns the oracle wallet's address.
 *
 * Calling this creates the wallet lazily if it doesn't yet exist. Handy for
 * programmatically pointing a BaseScan filter at the right EOA.
 *
 *   goldsky compose callTask generate_wallet '{}'
 */
export async function main(context: TaskContext) {
  const oracle = await getOracleWallet(context);
  return { address: oracle.address };
}
