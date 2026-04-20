/**
 * Minimal Polymarket CLOB client that uses ctx.fetch for all HTTP.
 *
 * The @polymarket/clob-client SDK uses axios, which fails under Compose's
 * Deno runtime (no --allow-net on task binaries). We reuse the SDK's pure
 * signing utilities (no HTTP) and route every API call through ctx.fetch,
 * which bridges to the host process that has network permissions.
 *
 * All requests are made to CLOB_HOST, which should point at our Fly.io
 * proxy in Frankfurt (clob.polymarket.com is geo-blocked from US-hosted
 * Compose tasks).
 */
import type { TaskContext } from "compose";
import { Wallet } from "@ethersproject/wallet";
import { OrderBuilder } from "@polymarket/clob-client/dist/order-builder/builder.js";
import { orderToJson } from "@polymarket/clob-client/dist/utilities.js";
import { Side, OrderType, SignatureType } from "@polymarket/clob-client";
import type { TickSize } from "@polymarket/clob-client";
import { createL1Headers, createL2Headers } from "@polymarket/clob-client/dist/headers/index.js";

const CHAIN_ID = 137;

type ApiCreds = { key: string; secret: string; passphrase: string };

let cachedCreds: ApiCreds | null = null;

function normalizePk(pk: string): `0x${string}` {
  return (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
}

/**
 * Fetch (or derive) the L2 API credentials for this wallet.
 * Uses L1 EIP-712 auth headers; POST /auth/api-key creates, GET /auth/derive-api-key fetches existing.
 */
export async function getApiCreds(
  ctx: TaskContext,
  privateKey: string,
  host: string
): Promise<ApiCreds> {
  if (cachedCreds) return cachedCreds;

  const wallet = new Wallet(normalizePk(privateKey));
  const l1Headers = await createL1Headers(wallet as any, CHAIN_ID);

  // Try create first; if already exists (empty key), fall back to derive
  try {
    const created = (await ctx.fetch(`${host}/auth/api-key`, {
      method: "POST",
      headers: l1Headers as Record<string, string>,
    })) as { apiKey?: string; secret?: string; passphrase?: string };

    if (created?.apiKey) {
      cachedCreds = {
        key: created.apiKey,
        secret: created.secret!,
        passphrase: created.passphrase!,
      };
      return cachedCreds;
    }
  } catch {
    // fall through to derive
  }

  const derived = (await ctx.fetch(`${host}/auth/derive-api-key`, {
    method: "GET",
    headers: l1Headers as Record<string, string>,
  })) as { apiKey: string; secret: string; passphrase: string };

  cachedCreds = {
    key: derived.apiKey,
    secret: derived.secret,
    passphrase: derived.passphrase,
  };
  return cachedCreds;
}

export type TradeResult = {
  success: boolean;
  orderId?: string;
  error?: string;
};

/**
 * Build, sign, and submit a FAK (Fill-and-Kill) market order to the CLOB.
 * All HTTP goes through ctx.fetch to the host → proxy → CLOB.
 */
export async function executeTrade(
  ctx: TaskContext,
  privateKey: string,
  host: string,
  tokenId: string,
  side: "BUY" | "SELL",
  amountUsd: number,
  whalePrice: number,
  tickSize: string,
  negRisk: boolean,
  feeRateBps: number,
  sellSize?: number
): Promise<TradeResult> {
  try {
    if (!whalePrice || whalePrice <= 0 || whalePrice >= 1) {
      return { success: false, error: `Invalid whale price: ${whalePrice}` };
    }

    // Round to tick size and compute size/amount matching SDK conventions
    const tick = parseFloat(tickSize) || 0.01;
    const price = Math.round(whalePrice / tick) * tick;

    // For BUY: smallest order that satisfies Polymarket's $1 minimum notional.
    // For SELL: sell everything we hold (mirrors the whale exiting).
    const shares =
      side === "SELL"
        ? Math.floor(sellSize ?? 0)
        : Math.max(1, Math.ceil(1 / price));

    if (shares < 1) {
      return { success: false, error: `size too small (${shares})` };
    }

    // SDK's `amount` param for createMarketOrder:
    //   BUY: USDC to spend (shares * price)
    //   SELL: shares to sell
    const amount = side === "BUY" ? shares * price : shares;

    const wallet = new Wallet(normalizePk(privateKey));
    const builder = new OrderBuilder(
      wallet as any,
      CHAIN_ID,
      SignatureType.EOA
    );

    console.log(
      `[clob] ${side} ${shares} shares @ ${price} (notional=$${(shares * price).toFixed(2)})`
    );

    // Build + sign the order locally (pure crypto, no HTTP)
    const signedOrder = await builder.buildMarketOrder(
      {
        tokenID: tokenId,
        price,
        amount,
        side: side === "BUY" ? Side.BUY : Side.SELL,
        feeRateBps,
      } as any,
      { tickSize: tickSize as TickSize, negRisk }
    );

    const creds = await getApiCreds(ctx, privateKey, host);
    const body = orderToJson(signedOrder, creds.key, OrderType.FAK);
    const bodyStr = JSON.stringify(body);

    const l2Headers = await createL2Headers(
      wallet as any,
      creds,
      { method: "POST", requestPath: "/order", body: bodyStr }
    );

    const resp = (await ctx.fetch(`${host}/order`, {
      method: "POST",
      headers: {
        ...l2Headers,
        "Content-Type": "application/json",
      } as Record<string, string>,
      body: bodyStr,
    })) as {
      orderID?: string;
      orderId?: string;
      errorMsg?: string;
      error?: string;
    };

    const orderId = resp.orderID || resp.orderId;
    const errorMsg = resp.errorMsg || resp.error;

    if (errorMsg) return { success: false, error: errorMsg, orderId };
    return { success: true, orderId };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
