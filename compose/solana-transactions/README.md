# Solana Transactions with Gill

A [Compose](https://docs.goldsky.com/compose/introduction) example that signs and sends a Solana transaction from inside a task, using [Gill](https://github.com/solana-foundation/gill) — a lightweight Solana client library — wired through Compose's sandboxed `fetch`.

Companion to the [Solana Transactions guide](https://docs.goldsky.com/compose/guides/solana-transactions).

## How It Works

```
┌─────────────┐                     ┌─────────────┐
│    HTTP     │   POST /task        │   Compose   │
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
                                    ┌─────────────┐
                                    │    Gill     │
                                    │ (sandboxed) │
                                    └──────┬──────┘
                                           │
                                           │ signed tx (base64)
                                           ▼
┌─────────────┐   sendTransaction   ┌─────────────┐
│   Solana    │ ◄────────────────── │   Compose   │
│  Program    │                     │    Task     │
└─────────────┘                     └──────┬──────┘
                                           │
                                           │ insertOne({price, timestamp})
                                           ▼
                                    ┌─────────────┐
                                    │ Collection  │
                                    │  (history)  │
                                    └─────────────┘
```

1. **HTTP trigger** invokes the task
2. **CoinGecko API** is called for the current BTC/USD price
3. **Gill** builds and signs a Solana transaction through a custom transport that wraps `context.fetch`
4. **Solana RPC** receives the base64-encoded, signed transaction
5. **Collection** stores the price and transaction signature for historical queries

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Set secrets

Add your Solana RPC URL and keypair as [secrets](https://docs.goldsky.com/compose/secrets). The keypair should be the same JSON byte-array format produced by `solana-keygen` (e.g. `[12, 34, ...]`).

Locally, create a `.env` file:

```
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_KEYPAIR=[12,34,56,...]
```

### 3. Run locally

```bash
compose run
```

### 4. Invoke the task

```bash
compose callTask solana_writer '{}'
```

### 5. Deploy to Goldsky

```bash
compose deploy
```

## Project Structure

```
solana-transactions/
├── compose.yaml                    # Compose configuration + secrets
├── package.json                    # Gill dependency
├── tsconfig.json                   # TypeScript config with Compose type paths
├── src/
│   └── tasks/
│       └── solana-writer.ts        # Main task: fetch price, sign + send tx, store
└── README.md
```

## Compose Features Demonstrated

- **HTTP triggers** — task invoked via an HTTP endpoint
- **Secrets** — `SOLANA_RPC_URL` and `SOLANA_KEYPAIR` injected via `context.env`
- **`context.fetch`** — all network calls (CoinGecko + Solana RPC) routed through the sandboxed fetch for auditability
- **Custom RPC transport** — Gill's `createSolanaRpcFromTransport` adapted to use `context.fetch` instead of the global `fetch`
- **`collection`** — persistent document storage for price history

## Customization

### Point at a different program

Replace the Anchor discriminator and `PROGRAM_ID` in `solana-writer.ts` with values from your program's IDL:

```typescript
const PROGRAM_ID = "YourProgramIdBase58...";
const WRITE_DISCRIMINATOR = new Uint8Array([/* 8 bytes from IDL */]);
```

The PDA seeds and instruction layout will also need to match your program.

### Use a different off-chain source

Swap the CoinGecko call for any API that returns JSON:

```typescript
const response = await fetch<{ price: number }>(
  "https://your-api.com/price",
  { max_attempts: 3, initial_interval_ms: 1000, backoff_factor: 2 }
);
```

### Reuse the transport pattern for other Solana libraries

The `createSandboxedTransport` helper isn't Gill-specific. Any Solana library that accepts a custom transport or fetch implementation can be wired through `context.fetch` the same way.

## Resources

- [Solana Transactions guide](https://docs.goldsky.com/compose/guides/solana-transactions)
- [Gill on GitHub](https://github.com/solana-foundation/gill)
- [Compose Documentation](https://docs.goldsky.com/compose/introduction)
- [Compose Secrets](https://docs.goldsky.com/compose/secrets)
