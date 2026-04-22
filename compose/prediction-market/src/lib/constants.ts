import type { Address } from "viem";

// ============ Chain ============

// Base Sepolia testnet. The Compose runtime pulls chain configs from viem/chains.
export const CHAIN = "baseSepolia" as const;

// Gnosis ConditionalTokens deployed on Base Sepolia. Verified upstream source:
//   https://sepolia.basescan.org/address/0xb04639fB29CC8D27e13727c249EbcAb0CDA92331
// The CTF is a generic, admin-less primitive. Anyone can call prepareCondition
// with any oracle address; our oracle EOA (see ORACLE_WALLET_NAME) is what
// namespaces our conditions on-chain.
export const CTF_ADDRESS: Address = "0xb04639fB29CC8D27e13727c249EbcAb0CDA92331";

// ============ Wallet ============

// Name of the Compose-managed wallet that acts as the market oracle.
// The same wallet signs prepareCondition (market launch) and reportPayouts
// (market resolution), and pays gas for both.
export const ORACLE_WALLET_NAME = "prediction-market-oracle";

// ============ Market ============

// Single-asset, single-duration demo. Extend these two constants (plus
// corresponding config in CoinGecko) to support more markets.
export const ASSET_PAIR = "BTC_USD" as const;
export const DURATION_SEC = 300; // 5 minutes
export const DURATION_MS = DURATION_SEC * 1000;

// Domain-separator string mixed into every questionId. Changing this after
// markets have been launched will orphan existing markets (different questionIds).
export const SALT = "GOLDSKY_COMPOSE_DEMO";

// ============ Price source ============

// Free public CoinGecko endpoint — no auth, rate-limited but well inside the
// free-tier budget at 12 req/hour.
export const PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";
