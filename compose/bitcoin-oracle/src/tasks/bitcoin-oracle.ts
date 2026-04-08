import { TaskContext } from "compose";

import { toBytes32 } from "../lib/utils";

const ORACLE_CONTRACT = "0x34a264BCD26e114eD6C46a15d0A3Ba1873CaA708";

export async function main(context: TaskContext) {
  const { fetch, evm, collection } = context;

  const wallet = await evm.wallet({ name: "bitcoin-oracle-wallet" });

  // Fetch Bitcoin price from CoinGecko API
  const response = await fetch<{ bitcoin: { usd: number } }>(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
    {
      max_attempts: 3,
      initial_interval_ms: 1000,
      backoff_factor: 2,
    }
  );

  if (!response) {
    throw new Error("Failed to fetch Bitcoin price");
  }

  const bitcoinPrice = response.bitcoin.usd;
  const timestamp = Date.now();

  // Convert timestamp and price to bytes32 format
  const timestampAsBytes32 = toBytes32(timestamp);
  const priceAsBytes32 = toBytes32(Math.round(bitcoinPrice * 100));

  // Write the price on-chain
  const onchainResponse = await wallet.writeContract(
    evm.chains.polygonAmoy,
    ORACLE_CONTRACT,
    "write(bytes32,bytes32)",
    [timestampAsBytes32, priceAsBytes32],
    {
      confirmations: 3,
      onReorg: {
        action: {
          type: "replay",
        },
        depth: 200,
      },
    },
    {
      max_attempts: 3,
      initial_interval_ms: 1000,
      backoff_factor: 2,
    }
  );

  // Store the price in a collection
  const priceHistory = await collection("bitcoin_prices");
  const { id } = await priceHistory.insertOne({
    price: bitcoinPrice,
    timestamp: timestamp,
  });

  return {
    success: true,
    oracleHash: onchainResponse.hash,
    price: bitcoinPrice,
    timestamp,
    priceId: id,
  };
}
