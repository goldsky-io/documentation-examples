import { TaskContext } from "compose";
import {
  MEGAETH_TESTNET_V2,
  CONTRACT_ADDRESS,
  WALLET_NAMES,
  CONTRACT_FUNCTIONS,
} from "../lib/constants.ts";

export async function main(context: TaskContext): Promise<{
  requestId: string;
  txHash: string;
}> {
  const wallet = await context.evm.wallet({
    name: WALLET_NAMES.REQUESTER,
    sponsorGas: false,
  });

  // Send the request
  const result = await wallet.writeContract(
    MEGAETH_TESTNET_V2,
    CONTRACT_ADDRESS,
    CONTRACT_FUNCTIONS.REQUEST_RANDOMNESS,
    []
  );

  // Read nextRequestId after tx - subtract 1 to get our requestId.
  // This is only used for fetching the randomness in the frontend UI.
  const response = await wallet.readContract(
    MEGAETH_TESTNET_V2,
    CONTRACT_ADDRESS,
    CONTRACT_FUNCTIONS.NEXT_REQUEST_ID,
    []
  );
  const requestId = String(BigInt(JSON.parse(response)) - 1n);

  return { requestId, txHash: result.hash };
}
