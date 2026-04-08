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
┌─────────────┐   write(bytes32,    ┌─────────────┐
│   On-chain  │   bytes32)          │   Compose   │
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
3. **On-chain contract** receives the price as `bytes32` via a managed Compose wallet
4. **Collection** stores the price for historical queries

## Quick Start

### 1. Generate types

```bash
compose codegen
```

### 2. Run locally

```bash
compose run
```

### 3. Deploy to Goldsky

```bash
compose deploy
```

The app will start writing Bitcoin prices on-chain every minute using a Compose-managed wallet.

## Project Structure

```
bitcoin-oracle/
├── compose.yaml                    # Compose configuration
├── tsconfig.json                   # TypeScript config with Compose type paths
├── src/
│   ├── lib/
│   │   └── utils.ts                # toBytes32 helper
│   └── tasks/
│       └── bitcoin-oracle.ts       # Main task: fetch price, write on-chain, store
└── README.md
```

## Compose Features Demonstrated

- **Cron triggers** — scheduled task execution on a fixed interval
- **`context.fetch`** — HTTP requests with built-in retry and backoff
- **`evm.wallet`** — managed wallet for signing on-chain transactions
- **`wallet.writeContract`** — smart contract writes with confirmation tracking and reorg handling
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

### Change the target chain

Update `evm.chains.polygonAmoy` to any supported chain:

```typescript
const onchainResponse = await wallet.writeContract(
  evm.chains.ethereum,       // or baseSepolia, arbitrum, etc.
  "0xYOUR_CONTRACT_ADDRESS",
  "write(bytes32,bytes32)",
  [timestampAsBytes32, priceAsBytes32],
);
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
- [CoinGecko API](https://www.coingecko.com/en/api)
