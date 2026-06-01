import { TaskContext, OnchainEvent } from "compose";

import {
  fetchLatestRandomness,
  toBytes32,
  toBytes,
  DRAND_CHAIN_INFO,
} from "../lib/drand.ts";

// Address of your deployed RandomnessConsumer (see README to deploy your own).
// No-deploy option: to get this running and see it all working without
// deploying anything, point this at the totally open RandomnessConsumer on Base
// Sepolia, where anyone can fulfill (no fulfiller gate):
// 0x6273AB73C95Ba2233281F1eb8aa3b21D9352AD6d. Keep this in sync with the
// CONTRACT_ADDRESS in request-randomness.ts and the `contract:` field in compose.yaml.
const CONTRACT_ADDRESS = "0xE05Ceb3E269029E3bab46E35515e8987060D1027";

/**
 * Fulfill randomness requests using drand
 *
 * Triggered by on-chain events (configured in compose.yaml)
 * Fetches verifiable randomness from drand and calls the target contract
 */
export async function main(context: TaskContext, event?: OnchainEvent) {
  const { fetch, evm } = context;

  // Parse request ID from event topics
  const requestId = event?.topics[1] ? BigInt(event.topics[1]) : 0n;

  // Fetch randomness from drand
  const drandResponse = await fetchLatestRandomness(fetch);

  console.log(`fetched drand round ${drandResponse.round}`);

  // Get wallet and instantiate typed contract (generated from src/contracts/RandomnessConsumer.json)
  const wallet = await evm.wallet({
    name: "randomness-fulfiller",
  });

  const contract = new evm.contracts.RandomnessConsumer(
    CONTRACT_ADDRESS,
    evm.chains.baseSepolia,
    wallet
  );

  // Prepare the fulfillment arguments
  const randomnessBytes32 = toBytes32(drandResponse.randomness);
  const signatureBytes = toBytes(drandResponse.signature);

  // Fulfill the randomness request on-chain
  const { hash } = await contract.fulfillRandomness(
    requestId.toString(),
    randomnessBytes32,
    drandResponse.round,
    signatureBytes
  );

  console.log(`fulfilled request ${requestId} in tx ${hash}`);

  return {
    success: true,
    requestId: requestId.toString(),
    transactionHash: hash,
    drand: {
      round: String(drandResponse.round),
      randomness: randomnessBytes32,
      chainHash: DRAND_CHAIN_INFO.hash,
    },
  };
}
