# Bitcoin Oracle

A [Compose](https://docs.goldsky.com/compose/introduction) example that fetches Bitcoin's price and writes it on-chain every minute.

## How It Works

```
┌─────────────┐                     ┌─────────────┐
│    Cron     │  every minute       │   Compose   │
│   Trigger   │ ──────────────────► │    Task     │
└─────────────┘                     └──────┬──────┘
                                           │
                                           │ fetch BTC price
                                           ▼
                                    ┌─────────────┐
                                    │  CoinGecko  │
                                    │     API     │
                                    └──────┬──────┘
                                           │
                                           │ {bitcoin: {usd: 97234.50}}
                                           ▼
┌─────────────┐   oracle.write(     ┌─────────────┐
│   On-chain  │   timestamp, price) │   Compose   │
│  Contract   │ ◄────────────────── │    Task     │
└─────────────┘                     └──────┬──────┘
                                           │
                                           │ insertOne({price, timestamp})
                                           ▼
                                    ┌─────────────┐
                                    │ Collection  │
                                    │  (history)  │
                                    └─────────────┘
```

1. **Cron trigger** fires every minute
2. **CoinGecko API** is called to fetch the current BTC/USD price
3. **On-chain contract** receives the price via a typed contract class and managed Compose wallet
4. **Collection** stores the price for historical queries

## Quick Start

### 1. Generate types and contract classes

```bash
compose codegen
```

This scans `src/contracts/PriceOracle.json` and generates a typed `PriceOracle` class in `.compose/generated/`.

### 2. Run locally

```bash
compose run
```

### 3. Deploy to Goldsky

```bash
compose deploy
```

> **Note:** Cloud deploy does not yet support contract codegen (tracked in [FOU-726](https://linear.app/goldsky/issue/FOU-726)). Until that's fixed, replace `oracle.write(...)` with `wallet.writeContract(chain, address, "write(bytes32,bytes32)", [...])` for cloud deployments.

## Project Structure

```
bitcoin-oracle/
├── compose.yaml                    # Compose configuration
├── tsconfig.json                   # TypeScript config with Compose type paths
├── src/
│   ├── contracts/
│   │   └── PriceOracle.json        # Contract ABI → generates typed class
│   ├── lib/
│   │   └── utils.ts                # toBytes32 helper
│   └── tasks/
│       └── bitcoin-oracle.ts       # Main task: fetch price, write on-chain, store
└── README.md
```

## Compose Features Demonstrated

- **Cron triggers** — scheduled task execution on a fixed interval
- **Contract codegen** — typed contract classes generated from ABI JSON files in `src/contracts/`
- **`context.fetch`** — HTTP requests with built-in retry and backoff
- **`evm.wallet`** — managed wallet for signing on-chain transactions
- **`evm.contracts`** — type-safe contract interaction (`oracle.write(...)` instead of raw function signatures)
- **`collection`** — persistent document storage with automatic indexing

## Customization

### Change the price source

Replace the CoinGecko URL in `bitcoin-oracle.ts` with any API that returns a JSON price:

```typescript
const response = await fetch<{ price: number }>(
  "https://your-api.com/price",
  { max_attempts: 3, initial_interval_ms: 1000, backoff_factor: 2 }
);
```

### Use your own contract

1. Drop your contract's ABI JSON into `src/contracts/MyContract.json`
2. Run `compose codegen` to generate the typed class
3. Use it in your task:

```typescript
const myContract = new evm.contracts.MyContract(
  "0xYOUR_CONTRACT_ADDRESS",
  evm.chains.ethereum,  // or baseSepolia, arbitrum, polygonAmoy, etc.
  wallet
);
await myContract.yourMethod(arg1, arg2);
```

### Change the cron schedule

Edit `compose.yaml`:

```yaml
triggers:
  - type: "cron"
    expression: "*/5 * * * *"  # every 5 minutes
```

## Resources

- [Compose Documentation](https://docs.goldsky.com/compose/introduction)
- [Contract Codegen Docs](https://docs.goldsky.com/compose/context/evm/contracts)
- [CoinGecko API](https://www.coingecko.com/en/api)
