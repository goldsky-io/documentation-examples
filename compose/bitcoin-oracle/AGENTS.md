# Agent Instructions — Compose bitcoin-oracle

The canonical, up-to-date setup procedure for this example lives in the **Goldsky agent plugin**, not in this repo. Install it and run the skill:

```bash
npx skills add goldsky-io/goldsky-agent
```

Then trigger **`/compose-bitcoin-oracle`** (or just ask your agent to "build a bitcoin price oracle"). That skill is the single source of truth: it scaffolds this example, recommends the shared fully-unpermissioned `PriceOracle` on Base Sepolia (nothing to deploy), and walks contract choice, wiring, deploy, and a log-tailing smoke test. Do not improvise a setup procedure from this README.

## One-line summary

Cron task (default every minute) that writes BTC/USD from CoinGecko to a `PriceOracle(bytes32 timestamp, bytes32 price)` contract via a Compose-managed wallet, and appends to a `bitcoin_prices` collection for historical queries. Base Sepolia by default; any EVM chain supported by Compose works.

## Key files

- `compose.yaml` — cron schedule and retry config
- `src/tasks/bitcoin-oracle.ts` — the cron task; the `ORACLE_CONTRACT` address and `evm.chains.*` reference are what the user edits
- `src/contracts/PriceOracle.json` — ABI only; the Solidity source is not included. The skill provides a minimal reference contract for fresh deploys.
- `src/lib/utils.ts` — `toBytes32` helper; do not modify.
