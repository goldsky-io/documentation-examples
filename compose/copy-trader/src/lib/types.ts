/**
 * Polymarket V2 contract addresses on Polygon.
 * V2 cutover: 2026-04-28 (https://docs.polymarket.com/v2-migration).
 *
 * Collateral is pUSD (a 1:1 wrapper around USDC.e). Users fund their wallet
 * with USDC.e and `setup_approvals` wraps it via the Collateral Onramp.
 */
export const CONTRACTS = {
  ctfExchangeV2: "0xE111180000d2663C0091e4f400237545B87B996B",
  negRiskExchangeV2: "0xe2222d279d744050d28e00520010520000310F59",
  conditionalTokens: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  collateralOnramp: "0x93070a847efEf7F70739046A929D47a521F5B8ee",
  pUSD: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
  usdc: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
} as const;

export const CHAIN_ID = 137;

/** Row from the Turbo pipeline's order_fills sink (V2 OrderFilled event). */
export type OrderFillRow = {
  id: string;
  block_number: number;
  log_index: number;
  transaction_hash: string;
  block_timestamp: string;
  maker: string;
  taker: string;
  /** Maker's side. "0" = BUY (maker pays pUSD for shares), "1" = SELL. */
  side: string;
  token_id: string;
  /** Decimal pUSD (6 decimals applied). */
  maker_amount: number;
  /** Decimal pUSD or shares depending on side. */
  taker_amount: number;
  fee: number;
};

/** Position tracked in collections */
export type Position = {
  id: string; // tokenId
  tokenId: string;
  conditionId: string;
  side: "YES" | "NO";
  size: number;
  avgPrice: number;
  status: "open" | "redeemed";
};

/** Trade record in collections */
export type Trade = {
  id: string;
  tokenId: string;
  side: "BUY" | "SELL";
  amount: number;
  price: number;
  whalePrice: number;
  slippage: number;
  orderId?: string;
  eventTxHash: string;
  timestamp: string;
};

/** Gamma API market info needed for trading */
export type MarketInfo = {
  tokenId: string;
  conditionId: string;
  question: string;
  tickSize: string;
  negRisk: boolean;
  enableOrderBook: boolean;
  closed: boolean;
  outcomePrices: [number, number];
  clobTokenIds: [string, string];
};
