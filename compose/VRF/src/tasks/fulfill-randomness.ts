import { TaskContext, OnchainEvent } from "compose";

import {
  fetchLatestRandomness,
  toBytes32,
  toBytes,
  DRAND_CHAIN_INFO,
} from "../lib/drand.ts";

/** The contract to call with the randomness */
const TARGET_CONTRACT = "0xE05Ceb3E269029E3bab46E35515e8987060D1027" as const;

/**
 * Fulfill randomness requests using drand
 *
 * Triggered by on-chain events (configured in compose.yaml)
 * Fetches verifiable randomness from drand and calls the target contract
 */
export async function main(context: TaskContext, event?: OnchainEvent) {
  const { fetch, evm, logEvent } = context;

  // Parse request ID from event topics
  const requestId = event?.topics[1] ? BigInt(event.topics[1]) : 0n;

  // Fetch randomness from drand
  const drandResponse = await fetchLatestRandomness(fetch);

  await logEvent({
    code: "DRAND_FETCHED",
    message: `Fetched drand round ${drandResponse.round}`,
    data: JSON.stringify({ round: drandResponse.round }),
  });

  // Get wallet for transaction
  const wallet = await evm.wallet({
    name: "randomness-fulfiller",
  });

  // Prepare the fulfillment arguments
  const randomnessBytes32 = toBytes32(drandResponse.randomness);
  const signatureBytes = toBytes(drandResponse.signature);

  // Call the target contract
  const result = await wallet.writeContract(
    evm.chains.baseSepolia,
    TARGET_CONTRACT,
    "fulfillRandomness(uint256,bytes32,uint64,bytes)",
    [
      requestId.toString(),
      randomnessBytes32,
      drandResponse.round,
      signatureBytes,
    ]
  );

  await logEvent({
    code: "RANDOMNESS_FULFILLED",
    message: `Fulfilled request ${requestId} in tx ${result.hash}`,
    data: JSON.stringify({
      requestId: requestId.toString(),
      txHash: result.hash,
    }),
  });

  return {
    success: true,
    requestId: requestId.toString(),
    transactionHash: result.hash,
    drand: {
      round: String(drandResponse.round),
      randomness: randomnessBytes32,
      chainHash: DRAND_CHAIN_INFO.hash,
    },
  };
}
