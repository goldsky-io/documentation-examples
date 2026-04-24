---
name: setup
description: Configure and deploy this Compose prediction-market example under the user's own Goldsky account. A cron orchestrator (default every 5 minutes on Base Sepolia) launches a fresh BTC UP/DOWN prediction market on the Gnosis ConditionalTokens (CTF) contract each cycle, resolves the previous cycle's market, and acts as the market oracle. Walks a new user through CLI install, choosing chain + asset + market duration, finding the correct CTF address on their chosen chain, optionally swapping the price source, optional GitHub publishing, and a BaseScan-style smoke test. No contracts to deploy, no private keys, no funding — gas is sponsored. Use when a user has just cloned this example or asks to set up / deploy / configure the prediction-market app.
---

# Setup: Compose prediction-market

This skill makes the cloned prediction-market example runnable under the user's own Goldsky account. A cron orchestrator fires every 5 minutes, calls a helper task to fetch BTC/USD from CoinGecko, resolves any overdue markets by reporting payouts on the Gnosis ConditionalTokens (CTF) contract, and prepares a fresh market for the current 5-minute bucket. The Compose-managed wallet is the sole oracle for every market it launches.

This is the lowest-setup-cost example in the repo: no contracts to deploy, no secrets, no funding. Most of the work is editing constants.

## Non-negotiables

- **Never run `goldsky compose deploy`, `git push`, or `gh repo create` without showing the exact command first and getting explicit confirmation.**
- **`SALT` (`src/lib/constants.ts:32`) is a domain separator mixed into every question ID.** If the user changes it after markets are live, all existing markets become orphaned on-chain (different `conditionId`, unreachable by the orchestrator). Only change `SALT` during initial setup, never afterward.
- **The oracle wallet is determined at first deploy.** The `conditionId` of every market is deterministically derived from `(oracle, questionId, 2)`. If the oracle wallet changes (e.g. user renames `ORACLE_WALLET_NAME` at `constants.ts:20`), every prior market is orphaned. Pick the name once.
- **`CTF_ADDRESS` (`constants.ts:13`) is chain-specific.** The Gnosis CTF is deployed at different addresses on different chains. Using the Base Sepolia address on Polygon will silently produce transactions that revert or hit an EOA. Always verify the address for the user's target chain.
- **`ASSET_PAIR` (`constants.ts:26`) and `PRICE_URL` (`constants.ts:38–39`) are coupled.** If the user wants ETH/USD instead of BTC/USD, they must update both constants *and* the response parser at `src/tasks/market-data.ts:25` (which currently reads `response.bitcoin.usd` — needs to change to `response.ethereum.usd`).

## Preflight

1. **`goldsky` CLI** — `goldsky --version`.
2. **`goldsky` authenticated** — `goldsky projects list`.
3. **`deno`** — `deno --version`.

That's it. No Foundry, no npm, no Solana tooling.

## Step 1 — Configuration interview

1. **"App name?"** (default: `prediction-market`) → `compose.yaml:1`.
2. **"Which chain?"** (default: `baseSepolia`) → `src/lib/constants.ts:6`. The Gnosis CTF is deployed on most major chains; common options include `baseSepolia`, `base`, `polygon`, `ethereum`. The user must give you the CTF contract address for their chosen chain; defaults are only known for Base Sepolia.
3. **"Which asset pair?"** (default: `BTC_USD`) — any asset CoinGecko supports. If the user picks something else (e.g. `ETH_USD`, `SOL_USD`), you'll update three places in Step 3.
4. **"Market duration?"** (default: 5 minutes, `DURATION_SEC = 300`) — longer durations produce fewer, larger markets. The cron cadence at `compose.yaml:11` and `DURATION_SEC` should usually match; if the user wants hourly markets, change both.
5. **"Domain salt?"** (default: `"GOLDSKY_COMPOSE_DEMO"`) — only needs to be changed if they want a fresh namespace (e.g. running multiple instances in the same Goldsky project). Once chosen, do not change.
6. **"Publish to a new GitHub repo?"** — optional.

## Step 2 — Determine the CTF contract address for the chosen chain

If the user picked `baseSepolia`, the default at `constants.ts:13` is correct: `0xb04639fB29CC8D27e13727c249EbcAb0CDA92331`.

Otherwise, the user must provide the Gnosis ConditionalTokens address for their chain. Canonical sources:
- Gnosis Conditional Tokens docs: https://docs.gnosis.io/conditionaltokens/docs/ethereum/
- Polymarket uses `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` on Polygon (mainnet).
- Base mainnet, Ethereum mainnet, etc. — look up the deployment on the relevant block explorer.

Call the address `$CTF`.

## Step 3 — Edit constants

In `src/lib/constants.ts`:
- Line 6: `export const CHAIN = "<camelCase chain>" as const;`
- Line 13: `export const CTF_ADDRESS: Address = "$CTF";`
- Line 20: `export const ORACLE_WALLET_NAME = "<stable name>";` — only change if the user wants a custom name. Once deployed, do not rename.
- Line 26: `export const ASSET_PAIR = "<e.g. ETH_USD>" as const;` (only if asset changed)
- Lines 27–28: `export const DURATION_SEC = <N>;` (only if duration changed; DURATION_MS derives from it)
- Line 32: `export const SALT = "<unique string>";` (only if user wants a custom namespace)
- Lines 38–39: `export const PRICE_URL = "<CoinGecko URL for chosen asset>";` (only if asset changed)

If `ASSET_PAIR` changed, also edit `src/tasks/market-data.ts:25` to read the correct field from the CoinGecko response. Example for ETH:

```typescript
const priceUsd = response?.ethereum?.usd;
```

Update the TypeScript type on line 16 to match (`{ ethereum?: { usd?: number } }`).

If market duration changed, also edit `compose.yaml:11` — the cron cadence should match `DURATION_SEC`. For 5-min markets: `"10 */5 * * * *"` (cron quantum seconds: 10s offset, every 5 min). For hourly markets: `"0 0 * * * *"` or similar.

## Step 4 — Optional: publish to a new GitHub repo

```bash
git init
git add .
git commit -m "Initial commit: Compose prediction-market"
gh repo create <user's repo name> --<public|private> --source=. --push
```

## Step 5 — Deploy to Goldsky

```bash
goldsky compose deploy
```

Gas is sponsored by default (`context.evm.wallet({ name: ORACLE_WALLET_NAME })` without explicit gas config uses Goldsky's sponsor) — the oracle wallet needs no funding.

## Step 6 — Smoke test

**Get the oracle wallet address:**

```bash
goldsky compose callTask generate_wallet '{}'
```

Returns the oracle's address. Save as `$ORACLE`.

**Tail logs and wait for the next cron fire.** Cron is `10 */5 * * * *` — fires at :10, :15, :20, etc. of each hour (with a 10-second offset from the boundary to let CoinGecko settle).

```bash
goldsky compose logs
```

Good output on first run:

```
cycle complete: price=<BTC/USD> resolved=0/0 launched=true resolveErrors=0 launchError=false
```

On the second and subsequent cycles, `resolved` should start showing `1/1` as the previous market becomes overdue.

**Verify on the explorer.** For Base Sepolia:

```
https://sepolia.basescan.org/address/$CTF#events
```

Filter events to the oracle address (`$ORACLE`) — topic[2] of `ConditionPreparation` and `ConditionResolution`. Each cron cycle should produce one `ConditionPreparation` (launch) and, after the first cycle, one `ConditionResolution` (resolve).

## Troubleshooting

- **`cycle complete` never logs.** Check that the deploy succeeded and the cron trigger is active: `goldsky compose info`.
- **`Unexpected CoinGecko response shape`.** The asset field in the response doesn't match. Re-check `src/tasks/market-data.ts:25` and ensure the field matches the asset in `PRICE_URL` (e.g. `ids=ethereum` → `response.ethereum.usd`).
- **`resolveErrors=1` or higher.** Check `goldsky compose logs` for the underlying error. Two benign cases (the code catches them): "condition already prepared" and "payout denominator already set" — both mean a retry hit a tx that landed but the client didn't know yet. Errors other than those are real problems.
- **No events on the explorer.** Verify `CTF_ADDRESS` points at the real Gnosis CTF on the chosen chain. An EOA or unrelated contract at the address will produce no events even though the tx succeeds.

## What you should NOT do

- Do not rename `ORACLE_WALLET_NAME` after deploying. Every prior market's `conditionId` is bound to the old wallet.
- Do not change `SALT` after deploying. Same orphaning problem.
- Do not change the hardcoded outcome count `"2"` at `src/tasks/launch-market.ts:42` to add more outcomes without also updating the payout logic in `resolve-market.ts` and the `Outcome` type. Out of scope for setup.
- Do not remove the `catch` block for "condition already prepared" / "payout denominator already set" in `launch-market.ts` or `resolve-market.ts`. These are idempotency guards that keep retries safe.
- Do not fund the oracle wallet — it's a gas-sponsored managed wallet. Sending ETH or tokens to it is just lost money; the orchestrator doesn't read balances.
