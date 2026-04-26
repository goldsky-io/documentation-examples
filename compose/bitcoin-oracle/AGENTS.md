# Agent Instructions — Compose bitcoin-oracle

If a user asks you to set up, configure, or deploy this example, follow the setup skill at:

**`.claude/skills/compose-bitcoin-oracle-setup/SKILL.md`**

That file is the canonical procedure. The example ships only the `PriceOracle` ABI (not Solidity source), so the skill handles two branches: bring-your-own contract (with a `setWriter`-style authorization step for the Compose wallet) or deploy-fresh (the skill provides the minimal reference `.sol`). It also walks through CLI install, chain selection, contract wiring, funding the Compose wallet (no sponsorship by default), optional GitHub publishing, and a log-tailing smoke test.

## One-line summary

Cron task (default every minute) that writes BTC/USD from CoinGecko to a `PriceOracle(bytes32 timestamp, bytes32 price)` contract via a Compose-managed wallet, and appends to a `bitcoin_prices` collection for historical queries. Polygon Amoy by default; any EVM chain supported by Compose works.

## Key files

- `compose.yaml` — cron schedule and retry config
- `src/tasks/bitcoin-oracle.ts` — the cron task; `ORACLE_CONTRACT` at line 5 and `evm.chains.*` at line 15 are what the user edits
- `src/contracts/PriceOracle.json` — ABI only; the Solidity source is not included. The skill provides a minimal reference contract for fresh deploys.
- `src/lib/utils.ts` — `toBytes32` helper; do not modify.
