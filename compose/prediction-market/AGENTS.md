# Agent Instructions — Compose prediction-market

If a user asks you to set up, configure, or deploy this example, follow the setup skill at:

**`.claude/skills/compose-prediction-market-setup/SKILL.md`**

That file is the canonical procedure. It covers CLI install, chain + asset + duration selection, finding the Gnosis CTF address for the chosen chain, the three-file update required to swap asset pair (constants, price URL, market-data response parser), optional GitHub publishing, and a BaseScan-style smoke test. No contracts to deploy, no secrets, no wallet funding — this is the lowest-setup-cost example in the repo.

## One-line summary

Cron-driven orchestrator (default every 5 min on Base Sepolia) that launches and resolves BTC UP/DOWN binary prediction markets on the Gnosis ConditionalTokens contract. The Compose-managed wallet is the oracle for every market it launches; gas is sponsored by Goldsky.

## Key files

- `compose.yaml` — 5 tasks: `orchestrator` (cron), `launch_market`, `resolve_market`, `market_data`, `generate_wallet` (http)
- `src/lib/constants.ts` — the hub of user-editable configuration (chain, CTF address, asset pair, duration, salt, price URL)
- `src/tasks/orchestrator.ts` — main cron, orchestrates resolve + launch per cycle
- `src/tasks/market-data.ts` — CoinGecko fetcher; response parser at line 25 is coupled to `ASSET_PAIR`
- `src/tasks/launch-market.ts` / `resolve-market.ts` — CTF interactions; idempotency guards that should not be removed
- `src/lib/utils.ts` — questionId / conditionId derivation (uses SALT); do not modify

## Non-obvious constraints

- `ORACLE_WALLET_NAME` and `SALT` are load-bearing: changing either after deployment orphans all existing markets because `conditionId` is derived from both.
- The CTF contract address is chain-specific. Only the default Base Sepolia address is verified in the repo.
- Gas is sponsored — the oracle wallet needs no funding.
