/**
 * copy_trade — HTTP-triggered by Turbo pipeline webhook
 *
 * Receives a decoded V2 OrderFilled event row from the pipeline.
 * Determines buy/sell side, looks up market via Gamma, places CLOB order.
 */
import type { TaskContext } from "compose";
import { privateKeyToAccount } from "viem/accounts";
import { executeTrade } from "../lib/clob";
import { lookupMarketByTokenId } from "../lib/gamma";
import { CONTRACTS } from "../lib/types";
import type { OrderFillRow, Position, Trade } from "../lib/types";

export async function main(ctx: TaskContext, params?: Record<string, unknown>) {
  console.log("[copy_trade] invoked with params:", JSON.stringify(params));
  if (!params) {
    return { status: "NO_PARAMS" };
  }

  const row = params as unknown as OrderFillRow;

  // Build watched wallet set from env (comma-separated)
  const watchedWallets = new Set(
    (ctx.env.WATCHED_WALLETS || "")
      .split(",")
      .map((w: string) => w.trim().toLowerCase())
      .filter(Boolean)
  );

  // Parse the fill to determine side and token
  const { side, tokenId, whalePrice } = parseFill(row, watchedWallets);
  console.log(`[copy_trade] parsed: side=${side} tokenId=${tokenId.slice(0,15)}... price=${whalePrice}`);
  if (!tokenId) {
    return { status: "SKIP_NO_TOKEN" };
  }

  const tradeAmount = parseFloat(ctx.env.TRADE_AMOUNT_USD || "50");

  // Resolve collections once (ctx.collection returns a Promise)
  const positionsCollection = await ctx.collection<Position>("positions");
  const tradesCollection = await ctx.collection<Trade>("trades");

  // Budget check: read pUSD balance on-chain (V2 collateral, source of truth).
  // If we don't have enough for the $1 minimum notional, skip. This avoids the
  // local budget counter drifting out of sync with the real wallet.
  if (side === "BUY") {
    const pk = ctx.env.PRIVATE_KEY as `0x${string}`;
    const address = privateKeyToAccount(
      pk.startsWith("0x") ? pk : (`0x${pk}` as `0x${string}`)
    ).address;
    const balResp = (await ctx.fetch(
      "https://polygon-bor-rpc.publicnode.com",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_call",
          params: [
            {
              to: CONTRACTS.pUSD,
              data: "0x70a08231000000000000000000000000" + address.slice(2).toLowerCase(),
            },
            "latest",
          ],
          id: 1,
        }),
      }
    )) as { result?: string };
    const pusdBalance = balResp?.result ? Number(BigInt(balResp.result)) / 1e6 : 0;
    if (pusdBalance < 1.1) {
      console.log(`[copy_trade] BALANCE_LOW: ${pusdBalance.toFixed(2)} pUSD (need >=1.10). Run setup_approvals to wrap USDC.e → pUSD.`);
      return { status: "BALANCE_LOW", balance: pusdBalance };
    }
  }

  // Look up market via Gamma
  const gammaHost = ctx.env.GAMMA_HOST || "https://gamma-api.polymarket.com";
  const market = await lookupMarketByTokenId(ctx.fetch, gammaHost, tokenId);

  if (!market) {
    console.log(`[copy_trade] MARKET_NOT_FOUND token=${tokenId.slice(0,15)}...`);
    return { status: "MARKET_NOT_FOUND", tokenId };
  }

  if (!market.enableOrderBook) {
    console.log(`[copy_trade] MARKET_CLOSED: ${market.question}`);
    return { status: "MARKET_CLOSED", market: market.question };
  }

  // For sells, check we actually hold the share on-chain via Polymarket's
  // data API (source of truth — the local positions collection can drift).
  let sellSize = 0;
  if (side === "SELL") {
    const pk = ctx.env.PRIVATE_KEY as `0x${string}`;
    const address = privateKeyToAccount(
      pk.startsWith("0x") ? pk : (`0x${pk}` as `0x${string}`)
    ).address;

    const positions = (await ctx.fetch(
      `https://data-api.polymarket.com/positions?user=${address}&limit=100&sortBy=CURRENT&sortOrder=DESC`
    )) as Array<{ asset: string; size: number }>;

    const match = positions.find((p) => p.asset === tokenId);
    if (!match || match.size <= 0) {
      console.log(
        `[copy_trade] NO_POSITION to sell for ${tokenId.slice(0, 15)}...`
      );
      return { status: "NO_POSITION" };
    }
    sellSize = match.size;
    console.log(
      `[copy_trade] have ${sellSize} shares on-chain for ${tokenId.slice(0, 15)}...`
    );
  }

  // Execute CLOB trade via proxy
  const result = await executeTrade(
    ctx,
    ctx.env.PRIVATE_KEY,
    ctx.env.CLOB_HOST || "https://fly-polymarket-proxy.fly.dev",
    tokenId,
    side,
    tradeAmount,
    whalePrice,
    market.tickSize,
    market.negRisk,
    sellSize
  );

  if (!result.success) {
    console.log(`[copy_trade] TRADE_FAILED: ${side} ${market.question} — ${result.error}`);
    return { status: "TRADE_FAILED", error: result.error, market: market.question };
  }

  console.log(`[copy_trade] TRADE_EXECUTED: ${side} ${market.question} — order ${result.orderId}`);

  // Update positions
  const existingPos = (await positionsCollection.findOne({
    tokenId,
  })) as Position | null;

  if (side === "BUY") {
    const shares = tradeAmount / whalePrice;
    if (existingPos) {
      const newSize = existingPos.size + shares;
      const newAvg =
        (existingPos.avgPrice * existingPos.size + whalePrice * shares) /
        newSize;
      await positionsCollection.setById(existingPos.id, {
        ...existingPos,
        size: newSize,
        avgPrice: newAvg,
      });
    } else {
      await positionsCollection.insertOne({
        id: tokenId,
        tokenId,
        conditionId: market.conditionId,
        side: market.clobTokenIds[0] === tokenId ? "YES" : "NO",
        size: shares,
        avgPrice: whalePrice,
        status: "open",
      });
    }

  } else {
    // Sell: zero out position
    if (existingPos) {
      await positionsCollection.setById(existingPos.id, {
        ...existingPos,
        size: 0,
      });
    }
  }

  // Record trade
  await tradesCollection.insertOne({
    id: `${row.transaction_hash}-${tokenId}-${Date.now()}`,
    tokenId,
    side,
    amount: tradeAmount,
    price: whalePrice,
    whalePrice,
    slippage: 0,
    orderId: result.orderId,
    eventTxHash: row.transaction_hash,
    timestamp: new Date().toISOString(),
  });

  return {
    status: "TRADE_EXECUTED",
    side,
    market: market.question,
    orderId: result.orderId,
  };
}

/**
 * Parse a V2 OrderFilled webhook payload to determine trade direction.
 *
 * V2 OrderFilled emits the MAKER's side (0 = BUY, 1 = SELL) and a single
 * `tokenId` (no more makerAssetId/takerAssetId pair). The whale we want to
 * copy may be the maker or the taker — taker takes the opposite side.
 *
 * Price = pUSD amount / shares amount. For a BUY-side maker, makerAmount is
 * pUSD and takerAmount is shares; for a SELL-side maker it's reversed.
 */
function parseFill(
  row: OrderFillRow,
  watchedWallets: Set<string>
): { side: "BUY" | "SELL"; tokenId: string; whalePrice: number } {
  const makerIsWhale = watchedWallets.has(row.maker.toLowerCase());
  const takerIsWhale = watchedWallets.has(row.taker.toLowerCase());

  // Maker's side as encoded in the event (uint8): "0" = BUY, "1" = SELL.
  const makerSide: "BUY" | "SELL" = row.side === "0" ? "BUY" : "SELL";
  const oppositeSide: "BUY" | "SELL" = makerSide === "BUY" ? "SELL" : "BUY";

  // Whichever side the whale is on, set their effective side.
  let whaleSide: "BUY" | "SELL";
  if (makerIsWhale) {
    whaleSide = makerSide;
  } else if (takerIsWhale) {
    whaleSide = oppositeSide;
  } else {
    // Shouldn't happen — pipeline filters to fills involving a watched wallet.
    return { side: "BUY", tokenId: "", whalePrice: 0 };
  }

  // Compute price: pUSD per share. Layout depends on the maker's side.
  //   makerSide = BUY:  makerAmount = pUSD,   takerAmount = shares
  //   makerSide = SELL: makerAmount = shares, takerAmount = pUSD
  const usdcAmount = makerSide === "BUY" ? row.maker_amount : row.taker_amount;
  const sharesAmount = makerSide === "BUY" ? row.taker_amount : row.maker_amount;
  const price = sharesAmount > 0 ? usdcAmount / sharesAmount : 0;

  return {
    side: whaleSide,
    tokenId: row.token_id,
    whalePrice: price,
  };
}
