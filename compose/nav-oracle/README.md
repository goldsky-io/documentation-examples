# Compose NAV Oracle

A [Compose](https://docs.goldsky.com/compose/introduction) example that publishes a tokenized fund's Net Asset Value to multiple chains on a schedule — an on-chain Proof-of-Reserves / NAV oracle in about 50 lines of TypeScript.

The deployed contract is [`AggregatorV3Interface`](https://docs.chain.link/data-feeds/api-reference#aggregatorv3interface)-compatible, so any existing Chainlink consumer can point at it unchanged.

## How It Works

```
┌─────────────┐   every 5 min    ┌─────────────┐   GET   ┌─────────────────┐
│    Cron     │ ───────────────► │   Compose   │ ──────► │  mock-custodian │
│   Trigger   │                  │    Task     │         │     .json       │
└─────────────┘                  └──────┬──────┘         └─────────────────┘
                                        │
                                        │ {totalNav, cash, tbills, repo, asOf}
                                        │
                              ┌─────────┴─────────┐
                              ▼                   ▼
                     ┌─────────────────┐ ┌─────────────────┐
                     │ ReserveAggregat │ │ ReserveAggregat │
                     │  (Base Sepolia) │ │  (Arb  Sepolia) │
                     └─────────────────┘ └─────────────────┘
```

1. **Cron trigger** fires every 5 minutes
2. **Mock custodian** returns a structured NAV bundle (cash, T-bills, repo, total NAV, timestamp, and a `ripcord` kill-switch)
3. **Compose task** validates the ripcord, scales values to 18 decimals, and publishes to the `ReserveAggregator` contract on two chains in one run
4. **`latestRoundData()`** on each contract returns the scalar NAV the way any Chainlink consumer expects. `latestBundle()` returns the full breakdown.

## Compose Features Demonstrated

- **Multi-chain publish** — one task writes to two chains in a single run, using `Promise.allSettled` so one chain's failure doesn't block the other
- **Operator ripcord** — a kill-switch baked into the data source that lets an operator halt publishing without touching the task
- **Structured on-chain state** — `(cash, tbills, repo, totalNav, asOf)` instead of a bare scalar
- **`AggregatorV3Interface` compatibility** — drop-in for any existing Chainlink consumer
- **Gas-sponsored wallet** — the publisher wallet never needs to hold ETH; `sponsorGas: true` is set on `evm.wallet()`
- **Cron triggers, managed wallet, typed contract classes** — shared with the other compose examples

## Quick Start

### 1. First deploy (registers the app + provisions the publisher wallet)

```bash
goldsky compose deploy
```

The task fires immediately but skips cleanly — the contract addresses are still placeholder zero-addresses. Check the logs for a line that looks like:

```
Publisher wallet ready at 0x1591A410c641062254189e49405E0A6321CE4580
```

Save that address — it's the wallet that will sign `updateNav` calls, and it's the `publisher` constructor arg for your `ReserveAggregator` contracts.

### 2. Deploy `ReserveAggregator` to both chains

Install [Foundry](https://book.getfoundry.sh/getting-started/installation) if you haven't already.

```bash
# Base Sepolia
forge create contracts/ReserveAggregator.sol:ReserveAggregator \
  --rpc-url https://sepolia.base.org \
  --private-key $PRIVATE_KEY \
  --broadcast --root . \
  --constructor-args 0xYOUR_PUBLISHER_ADDRESS "Your Fund NAV / USD"

# Arbitrum Sepolia
forge create contracts/ReserveAggregator.sol:ReserveAggregator \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc \
  --private-key $PRIVATE_KEY \
  --broadcast --root . \
  --constructor-args 0xYOUR_PUBLISHER_ADDRESS "Your Fund NAV / USD"
```

A demo pair is already deployed if you just want to watch:
- Base Sepolia: [`0x8099A30Ac752f86C77A0e0210085a908ba6d02fE`](https://sepolia.basescan.org/address/0x8099A30Ac752f86C77A0e0210085a908ba6d02fE)
- Arbitrum Sepolia: [`0x02D9Df62B7AED15739D638B92BAcEA2ce4Cb3d70`](https://sepolia.arbiscan.io/address/0x02D9Df62B7AED15739D638B92BAcEA2ce4Cb3d70)

### 3. Wire in the addresses and redeploy

Open `src/tasks/nav-oracle.ts` and replace the two placeholder constants near the top:

```ts
const BASE_SEPOLIA_AGGREGATOR     = "0x..."; // from step 2
const ARBITRUM_SEPOLIA_AGGREGATOR = "0x..."; // from step 2
```

Then redeploy:

```bash
goldsky compose deploy
```

### 4. Watch it publish

```bash
goldsky compose logs
```

Within 5 minutes you should see both transactions land. Confirm on the explorers:
- [Base Sepolia contract activity](https://sepolia.basescan.org/address/0x8099A30Ac752f86C77A0e0210085a908ba6d02fE#events)
- [Arbitrum Sepolia contract activity](https://sepolia.arbiscan.io/address/0x02D9Df62B7AED15739D638B92BAcEA2ce4Cb3d70#events)

## Customization

### Swap the data source

Open `src/tasks/nav-oracle.ts` and replace `CUSTODIAN_URL` with your own endpoint. Your API must return this shape:

```json
{
  "accountName": "Your Fund",
  "asOf": "2026-04-22T14:00:00Z",
  "cash": 125000.00,
  "tbills": 42500000.00,
  "repo": 8200000.00,
  "totalNav": 50825000.00,
  "ripcord": false
}
```

Amounts are human-readable USD (the task scales to 18 decimals before writing).

### Use the ripcord

If your custodian API returns `"ripcord": true`, the task logs `Ripcord engaged …` and skips the publish without erroring. Flip it back to `false` to resume. Useful for a circuit-breaker the operator controls out-of-band.

### Add or swap chains

`src/tasks/nav-oracle.ts` currently targets `evm.chains.baseSepolia` and `evm.chains.arbitrumSepolia`. Add another `new evm.contracts.ReserveAggregator(...)` in the `Promise.allSettled` block to publish to a third chain.

### Change publish cadence

Edit the cron expression in `compose.yaml`. Real PoR / NAV feeds are typically hourly or daily; this example runs every 5 minutes for demo liveness.

## Project Structure

```
nav-oracle/
├── compose.yaml                    # Compose configuration
├── mock-custodian.json             # Default data source (swap for your API)
├── contracts/
│   └── ReserveAggregator.sol       # AggregatorV3Interface-compatible publisher contract
├── src/
│   ├── lib/
│   │   └── scaling.ts              # USD → 18-decimal bigint helper
│   └── tasks/
│       └── nav-oracle.ts           # The cron task
└── README.md
```

## Notes

- `ReserveAggregator.getRoundData(_roundId)` only returns data for the latest round — this demo contract does not store history. For a production feed you'd add a round-indexed mapping.
- The contract is single-operator by design: the publisher address is fixed in the constructor and only it can call `updateNav`. Rotate with `setPublisher(newAddress)`.
- There's no automated test suite for the Solidity. The contract is ~120 lines and intentionally unaudited — do not use it in production without a proper review.

## Resources

- [Compose Documentation](https://docs.goldsky.com/compose/introduction)
- [AggregatorV3Interface reference](https://docs.chain.link/data-feeds/api-reference#aggregatorv3interface)
- [Foundry Book](https://book.getfoundry.sh/)
