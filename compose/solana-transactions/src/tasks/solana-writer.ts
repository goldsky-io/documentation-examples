import { TaskContext } from "compose";
import {
  createSolanaRpcFromTransport,
  createKeyPairFromBytes,
  createSignerFromKeyPair,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  createTransaction,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  getBase64EncodedWireTransaction,
  AccountRole,
} from "gill";

const PROGRAM_ID = "4MUYDek4T93NNN9dsRfxRTZc4KznZ1vTTe4vLtoS2AEs";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const DEVNET_RPC_URL = "https://api.devnet.solana.com";

// Anchor instruction discriminator for "write" (from IDL)
const WRITE_DISCRIMINATOR = new Uint8Array([235, 116, 91, 200, 206, 170, 144, 120]);

function toBytes32(value: number): Uint8Array {
  const bytes = new Uint8Array(32);
  let remaining = value;
  for (let i = 31; i >= 0 && remaining > 0; i--) {
    bytes[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return bytes;
}

function createSandboxedTransport(
  rpcUrl: string,
  sandboxedFetch: TaskContext["fetch"],
) {
  return async <TResponse>({
    payload,
  }: {
    payload: unknown;
    signal?: AbortSignal;
  }): Promise<TResponse> => {
    const result = await sandboxedFetch<TResponse>(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (result === undefined) {
      throw new Error(`Solana RPC request failed for ${rpcUrl}`);
    }
    return result;
  };
}

export async function main(context: TaskContext) {
  const { fetch, env, collection } = context;

  // --- Solana RPC setup ---
  const rpcUrl = env.SOLANA_RPC_URL || DEVNET_RPC_URL;
  const transport = createSandboxedTransport(rpcUrl, fetch);
  const rpc = createSolanaRpcFromTransport(transport);

  // --- Load signer ---
  const keypairBytes = new Uint8Array(JSON.parse(env.SOLANA_KEYPAIR));
  const keyPair = await createKeyPairFromBytes(keypairBytes);
  const signer = await createSignerFromKeyPair(keyPair);

  // --- Fetch Bitcoin price ---
  const response = await fetch<{ bitcoin: { usd: number } }>(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
    { max_attempts: 3, initial_interval_ms: 1000, backoff_factor: 2 },
  );

  if (!response) {
    throw new Error("Failed to fetch Bitcoin price");
  }

  const bitcoinPrice = response.bitcoin.usd;
  const timestamp = Date.now();

  // --- Build transaction ---
  const key = toBytes32(timestamp);
  const value = toBytes32(Math.round(bitcoinPrice * 100));

  // Derive PDA: seeds = ["data", signer_pubkey, key]
  const addressEncoder = getAddressEncoder();
  const signerPubkeyBytes = addressEncoder.encode(signer.address);

  const [pda] = await getProgramDerivedAddress({
    programAddress: address(PROGRAM_ID),
    seeds: [new TextEncoder().encode("data"), signerPubkeyBytes, key],
  });

  // Instruction data: 8-byte discriminator + 32-byte key + 32-byte value
  const instructionData = new Uint8Array(8 + 32 + 32);
  instructionData.set(WRITE_DISCRIMINATOR, 0);
  instructionData.set(key, 8);
  instructionData.set(value, 40);

  const writeInstruction = {
    programAddress: address(PROGRAM_ID),
    accounts: [
      { address: pda, role: AccountRole.WRITABLE as const },
      { address: signer.address, role: AccountRole.WRITABLE_SIGNER as const },
      { address: address(SYSTEM_PROGRAM), role: AccountRole.READONLY as const },
    ],
    data: instructionData,
  };

  // --- Sign and send ---
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const tx = createTransaction({
    version: "legacy",
    feePayer: signer,
    instructions: [writeInstruction],
    latestBlockhash,
  });

  const signedTx = await signTransactionMessageWithSigners(tx);
  const signature = getSignatureFromTransaction(signedTx);

  const encodedTx = getBase64EncodedWireTransaction(signedTx);
  await rpc.sendTransaction(encodedTx, { encoding: "base64" }).send();

  // --- Store result ---
  const priceHistory = await collection("bitcoin_prices");
  const { id } = await priceHistory.insertOne({
    price: bitcoinPrice,
    timestamp,
  });

  return { success: true, signature, price: bitcoinPrice, timestamp, priceId: id };
}
