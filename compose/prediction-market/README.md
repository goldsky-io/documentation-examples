# Prediction Market

A [Compose](https://docs.goldsky.com/compose/introduction) example that runs a self-contained binary prediction market on [Gnosis ConditionalTokens (CTF)](https://docs.gnosis.io/conditionaltokens/). Every 5 minutes, a single cron orchestrator creates a new "will BTC go up over the next 5 minutes?" market and resolves the previous one.

## How It Works

```
┌─────────────┐  cron every 5 min  ┌─────────────────────────────┐
│    Cron     │ ─────────────────► │         orchestrator        │
└─────────────┘                    │                             │
                                   │  1. fetch BTC price         │
                                   │  2. resolve prior market    │
                                   │  3. launch new market       │
                                   └──┬──────────┬──────────┬────┘
                                      │          │          │
                                callTask   callTask   callTask
                                      │          │          │
                                      ▼          ▼          ▼
                           ┌──────────┐ ┌────────┐ ┌──────────┐
                           │market_   │ │resolve_│ │ launch_  │
                           │data      │ │market  │ │ market   │
                           │(HTTP)    │ │(chain) │ │ (chain)  │
                           └────┬─────┘ └────┬───┘ └────┬─────┘
                                │            │          │
                                ▼            ▼          ▼
                           CoinGecko  Gnosis ConditionalTokens
                                      on Base Sepolia
```

On every cron tick:

1. **market_data** fetches the current BTC/USD price from CoinGecko.
2. Any markets whose `endTime` has passed are resolved on-chain via `reportPayouts`. The outcome is `[1, 0]` (UP) if the current price is ≥ the stored `openPrice`, else `[0, 1]` (DOWN).
3. A new market is prepared via `prepareCondition` for the current 5-minute bucket. The price fetched in step 1 becomes its `openPrice`.

One CoinGecko request serves both the closing tick of the expiring market and the opening tick of the new one — they sit on the same 5-minute bucket boundary.

## Compose Features Demonstrated

- **Cron triggers** — `"10 */5 * * * *"` scheduled orchestration.
- **`context.callTask` fan-out** — orchestrator delegates to three specialized worker tasks with their own retry configs.
- **Compose-managed wallets** — `context.evm.wallet({ name })` lazily creates a named EOA that signs on-chain transactions.
- **Typed contracts via codegen** — `src/contracts/ConditionalTokens.json` ABI is compiled into a typed `evm.contracts.ConditionalTokens` class by `compose codegen`.
- **HTTP host function with retries** — `context.fetch<T>(url, { max_attempts, ... })` for the CoinGecko call.
- **Collection-backed state** — markets are persisted by questionId with indexes on `endTime` and `resolved`.
- **Idempotent error handling** — re-running `prepareCondition` or `reportPayouts` after a crash is safe; the tasks catch `"condition already prepared"` / `"payout denominator already set"` and persist the DB state.

## Quick Start

### 1. Install

```bash
npm install
```

### 2. Generate the typed contract class

```bash
compose codegen
```

This scans `src/contracts/ConditionalTokens.json` and produces a typed wrapper class at `.compose/generated/contracts/ConditionalTokens.ts`.

### 3. Deploy

```bash
compose deploy -t $COMPOSE_API_KEY
```

The first cron tick will fail — the oracle wallet has no gas yet. That's expected. Proceed to step 4.

### 4. Find and fund the oracle wallet

```bash
goldsky compose callTask generate_wallet '{}'
```

Copy the address from the output, then fund it with Base Sepolia ETH:

- [Coinbase Base Sepolia faucet](https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet) — drip is weeks of gas at Base Sepolia prices.

### 5. Watch it run

```bash
compose logs
```

Within 5 minutes the next cron tick fires and the app self-heals. Look for `cycle complete` log lines and `ConditionPreparation` / `ConditionResolution` events on [BaseScan](https://sepolia.basescan.org/address/0xb04639fB29CC8D27e13727c249EbcAb0CDA92331).

## Project Structure

```
prediction-market/
├── compose.yaml                  # 1 cron + 4 callable tasks
├── package.json                  # viem dependency
├── tsconfig.json                 # Compose path alias
├── src/
│   ├── contracts/
│   │   └── ConditionalTokens.json  # ABI → typed contract class
│   ├── lib/
│   │   ├── constants.ts          # Chain, CTF address, wallet name, salt, URL
│   │   ├── types.ts              # Market type
│   │   └── utils.ts              # questionId derivation, wallet helper
│   └── tasks/
│       ├── orchestrator.ts       # Cron: fetch → resolve → launch
│       ├── market-data.ts        # HTTP: CoinGecko
│       ├── launch-market.ts      # Chain: prepareCondition
│       ├── resolve-market.ts     # Chain: reportPayouts
│       └── generate-wallet.ts    # HTTP: prints oracle address
└── README.md
```

## Design Notes

### Oracle is an EOA, not a contract

The CTF's only requirement for an oracle is that `msg.sender == oracle` when `reportPayouts` is called. An EOA satisfies that. Using the Compose-managed wallet directly:

- Gives each deploy a unique oracle address — conditionIds on-chain are namespaced by `(oracle, questionId, outcomeSlotCount)`, so different deploys produce different conditions even for the same market parameters.
- Eliminates the need to deploy a custom resolver contract.
- Demonstrates `context.evm.wallet` as a first-class on-chain identity.

### One price fetch per cycle

The closing tick of market N sits at exactly the opening tick of market N+1 (both on the same 5-minute bucket boundary). A single CoinGecko call per cycle is used for both — see `orchestrator.ts`.

### Deterministic retries

When the orchestrator is about to resolve a market, it first snapshots the `closePrice` into the Market record in the database, **before** calling `resolve_market`. If the chain write fails and the next cron tick picks it up, it uses the stored `closePrice` instead of re-fetching — so the UP/DOWN verdict stays stable across retries.

## Production Caveats

This is a demo. Before using anything resembling this in production:

- **Decentralized oracle.** CoinGecko is off-chain, single-source, and not tamper-proof. Use a decentralized price oracle.
- **Dispute window.** Real prediction markets let users challenge outcomes before payouts are final. This example reports payouts the moment the market ends.
- **Multi-sig resolver.** A single EOA as the oracle is a single point of failure and compromise. Production systems use multi-sig or DON consensus.
- **Price snapshotting.** We snapshot the closing price at retry time (approximate). A production app should anchor to the actual price at `endTime` (e.g., a historical price oracle or an on-chain snapshot).

## Pointers

- [Gnosis ConditionalTokens docs](https://docs.gnosis.io/conditionaltokens/)
- [BaseScan — the CTF we use](https://sepolia.basescan.org/address/0xb04639fB29CC8D27e13727c249EbcAb0CDA92331)
- [Compose documentation](https://docs.goldsky.com/compose/introduction)
- [Chainlink CRE prediction market template](https://docs.chain.link/cre-templates/prediction-market) — a more production-shaped reference design
