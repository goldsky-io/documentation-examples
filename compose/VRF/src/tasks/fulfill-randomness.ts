import { TaskContext, OnchainEvent } from "compose";
import {
  MEGAETH_TESTNET_V2,
  CONTRACT_ADDRESS,
  WALLET_NAMES,
  CONTRACT_FUNCTIONS,
} from "../lib/constants.ts";
import {
  fetchLatestRandomness,
  toBytes32,
  toBytes,
  DRAND_CHAIN_INFO,
} from "../lib/drand.ts";

export async function main(context: TaskContext, event?: OnchainEvent) {
  const { fetch, evm, logEvent } = context;

  const requestId = event?.topics[1] ? BigInt(event.topics[1]) : 0n;

  // Fetch randomness from drand
  const drand = await fetchLatestRandomness(fetch);

  await logEvent({
    code: "DRAND_FETCHED",
    message: `Fetched drand round ${drand.round}`,
  });

  const wallet = await evm.wallet({
    name: WALLET_NAMES.FULFILLER,
    sponsorGas: false,
  });

  // Fulfill the randomness request
  const result = await wallet.writeContract(
    MEGAETH_TESTNET_V2,
    CONTRACT_ADDRESS,
    CONTRACT_FUNCTIONS.FULFILL_RANDOMNESS,
    [
      requestId.toString(),
      toBytes32(drand.randomness),
      drand.round,
      toBytes(drand.signature),
    ]
  );

  await logEvent({
    code: "RANDOMNESS_FULFILLED",
    message: `Fulfilled request ${requestId} in tx ${result.hash}`,
  });

  return {
    success: true,
    requestId: requestId.toString(),
    transactionHash: result.hash,
    drand: {
      round: String(drand.round),
      randomness: toBytes32(drand.randomness),
      chainHash: DRAND_CHAIN_INFO.hash,
    },
  };
}
