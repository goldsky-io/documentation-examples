/**
 * drand API utilities for fetching verifiable randomness
 *
 * drand produces BLS12-381 threshold signatures that anyone can verify.
 * The randomness is sha256(signature), making it deterministic and verifiable.
 */

// ============ Types ============

export type DrandResponse = {
  round: number;
  randomness: string; // hex - sha256(signature)
  signature: string; // hex - BLS12-381 signature (96 bytes)
  previous_signature: string;
};

export type DrandChainInfo = {
  hash: string;
  publicKey: string;
  genesisTime: number;
  period: number;
};

// ============ Constants ============

/**
 * drand quicknet chain info (3 second rounds)
 * Use these values to verify randomness off-chain
 *
 * Note: Quicknet uses "unchained" randomness (no previous_signature linking)
 * and BLS signatures on G1 curve instead of G2
 */
export const DRAND_CHAIN_INFO: DrandChainInfo = {
  hash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  publicKey:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  genesisTime: 1692803367,
  period: 3, // seconds between rounds
};

export const DRAND_API_URL =
  "https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";

// ============ Functions ============

/**
 * Fetch the latest randomness from drand
 */
export async function fetchLatestRandomness(
  fetchFn: <T>(url: string) => Promise<T | undefined>
): Promise<DrandResponse> {
  const response = await fetchFn<DrandResponse>(
    `${DRAND_API_URL}/public/latest`
  );

  if (!response) {
    throw new Error("Failed to fetch randomness from drand");
  }

  return response;
}

/**
 * Fetch randomness for a specific round
 */
export async function fetchRandomnessForRound(
  fetchFn: <T>(url: string) => Promise<T | undefined>,
  round: number
): Promise<DrandResponse> {
  const response = await fetchFn<DrandResponse>(
    `${DRAND_API_URL}/public/${round}`
  );

  if (!response) {
    throw new Error(`Failed to fetch randomness for round ${round}`);
  }

  return response;
}

/**
 * Convert hex string to bytes32 format (with 0x prefix, 64 chars)
 */
export function toBytes32(hex: string): `0x${string}` {
  // Remove 0x prefix if present
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  // Pad to 64 characters (32 bytes)
  const padded = clean.padStart(64, "0");
  return `0x${padded}` as `0x${string}`;
}

/**
 * Convert hex string to bytes (with 0x prefix)
 */
export function toBytes(hex: string): `0x${string}` {
  const clean = hex.startsWith("0x") ? hex : `0x${hex}`;
  return clean as `0x${string}`;
}
