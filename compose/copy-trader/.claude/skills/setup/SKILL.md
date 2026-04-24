---
name: setup
description: Configure and deploy this Compose + Turbo copy-trader example under the user's own Goldsky account. A Turbo pipeline indexes Polymarket OrderFilled events on Polygon for a set of watched wallets and webhooks each fill into a Compose app, which mirrors the trade on the Polymarket CLOB via a Fly.io proxy. Walks a new user through CLI install, picking wallets to copy, funding an EOA with USDC.e, creating `PRIVATE_KEY` + `COMPOSE_WEBHOOK_AUTH` secrets, deploying the Compose app and pipeline, running one-time approvals, optional GitHub publishing, and a smoke test using a real or synthetic fill. Use when a user has just cloned this example or asks to set up / deploy / configure the copy-trader app.
---

# Setup: Compose copy-trader

This skill makes the cloned copy-trader example runnable under the user's own Goldsky account. Two moving parts: a Turbo pipeline (`pipeline/polymarket-ctf-events.yaml`) that indexes Polymarket `OrderFilled` events on Polygon and webhooks them into Compose, and a Compose app (`compose.yaml`) with three tasks — `copy_trade` (http, mirrors each fill), `setup_approvals` (http, one-time), and `redeem` (cron every 5 min).

This is the most complex example. Do not skip any preflight or ordering step.

## Non-negotiables

- **Never run `goldsky compose deploy`, `goldsky turbo apply`, `goldsky secret create`, `goldsky compose secret set`, `git push`, or `gh repo create` without showing the exact command first and getting explicit confirmation.**
- **`WATCHED_WALLETS` must be identical in two places:** `compose.yaml:12` (comma-separated env var) and `pipeline/polymarket-ctf-events.yaml:62–69` (SQL `IN` lists for both `maker` and `taker`). Mismatch = fills get indexed but not mirrored, or vice versa. Triple-check the addresses are lowercased, comma-separated, and identical in casing.
- **Order of operations matters:** deploy the Compose app *first*, because the pipeline YAML's webhook URL contains the Compose app name. If you deploy the pipeline before the app exists (or with a stale app name), every webhook will 404.
- **The `PRIVATE_KEY` secret is a real funded EOA on Polygon mainnet.** This is not a testnet. Treat the key with care; do not print it, commit it, or log it. Polymarket CLOB orders are signed as this EOA — orders execute for real money.
- **US geo-blocking:** Polymarket's CLOB API blocks US IPs. Compose hosts may be in the US. The default `CLOB_HOST` is a shared Fly.io proxy in the EU. For production, the user should deploy their own proxy (link in README).

## Preflight

1. **`goldsky` CLI** — `goldsky --version`.
2. **`goldsky` authenticated** — `goldsky project list`.
3. **`node` + `npm`** — `npm --version`. Run `npm install` before anything else; Compose bundles `package-lock.json` deps with esbuild.
4. **`foundry` (optional)** — `cast --version`. Useful for checking USDC.e balance and deriving an address from a private key during setup.

## Step 1 — Configuration interview

1. **"App name?"** (default: `copy-trader`) → `compose.yaml:1`. This also becomes a path segment in the pipeline's webhook URL (pipeline YAML line 76). If you rename it, you'll update both places in Step 4.
2. **"Which wallets do you want to copy?"** — one or more Polygon EOAs. Lowercase, comma-separated. These are the "whales" the bot mirrors.
3. **"Trade size per fill (USD notional)?"** (default: `"1"`, the Polymarket minimum). → `compose.yaml:16`.
4. **"Do you want to use the shared Fly.io proxy (default) or your own?"** — default is fine for testing. For production, recommend deploying https://github.com/goldsky-io/fly-polymarket-proxy and setting `CLOB_HOST` to that deployment's URL.
5. **"Do you have a Polygon EOA you want to use, or should we generate a fresh one?"** — this EOA holds USDC.e and signs CLOB orders. If generating fresh, `cast wallet new` produces `(address, private_key)`. Record both.
6. **"Publish to a new GitHub repo?"** — optional.

## Step 2 — Install dependencies

```bash
npm install
```

Required for Compose's bundler to resolve imports (`viem`, etc.).

## Step 3 — Edit `compose.yaml`

- Line 1: `name: "<app name>"`
- Line 12: `WATCHED_WALLETS: "<comma-separated lowercase addresses>"`
- Line 16: `TRADE_AMOUNT_USD: "<size>"` (keep as `"1"` for first run)
- Line 20: `CLOB_HOST` — only change if user has their own proxy.

## Step 4 — Edit `pipeline/polymarket-ctf-events.yaml`

- Lines 62–69: Replace `'0xWALLET_1', '0xWALLET_2'` with the same lowercased addresses from `WATCHED_WALLETS`. Both the `maker IN (...)` and `taker IN (...)` blocks must match.
- Line 76: Update the URL's path segment if the app name is not `copy-trader`: `https://api.goldsky.com/api/admin/compose/v1/<app name>/tasks/copy_trade`.

## Step 5 — Create the `PRIVATE_KEY` secret

Set the EOA private key (the one funding USDC.e and signing orders):

```bash
goldsky compose secret set PRIVATE_KEY --value "0x<hex>"
```

This is a Compose-app-scoped secret referenced at `compose.yaml:5`. The `0x` prefix is tolerated but optional.

## Step 6 — Create the `COMPOSE_WEBHOOK_AUTH` secret (project-scoped, one-time)

The pipeline needs a bearer token to POST into the Compose app. This is a **project-level** secret (not per-app), so it only needs to be created once per Goldsky project — if the user has already created it for another pipeline, skip this step.

First, the user needs a Compose API token. There's no CLI command for this — direct them to the Goldsky dashboard (https://app.goldsky.com) to create one. Have them export it to a shell variable so it doesn't end up in their shell history directly:

```bash
read -s COMPOSE_TOKEN && export COMPOSE_TOKEN
# paste the token, press Enter (the -s flag hides input)
```

Then create the project-scoped webhook auth secret:

```bash
goldsky secret create --name COMPOSE_WEBHOOK_AUTH \
  --value "{\"type\": \"httpauth\", \"secretKey\": \"Authorization\", \"secretValue\": \"Bearer $COMPOSE_TOKEN\"}"
```

Referenced at pipeline YAML line 77.

## Step 7 — Deploy Compose app first, then the pipeline

Order matters — see Non-negotiables.

```bash
goldsky compose deploy
```

Capture the deployed app's base URL from the output (e.g. `https://api.goldsky.com/api/admin/compose/v1/<app name>/`).

Then:

```bash
goldsky turbo apply pipeline/polymarket-ctf-events.yaml
```

The pipeline starts indexing from `latest` (real-time fills).

## Step 8 — Fund the EOA with USDC.e on Polygon

Derive the EOA address from the private key:

```bash
cast wallet address --private-key "0x<hex>"
```

Call it `$EOA_ADDRESS`. Send **USDC.e** — contract `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` on Polygon mainnet — to that address. Recommended starting balance: $5–10 (enough for several $1 mirror trades and the $1.10 balance floor the bot enforces).

**Do not send MATIC.** Compose sponsors gas (`sponsorGas: true` in the tasks); the EOA only needs USDC.e, not MATIC.

Verify balance:

```bash
cast call 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 \
  "balanceOf(address)(uint256)" $EOA_ADDRESS \
  --rpc-url https://polygon-bor-rpc.publicnode.com
```

Divide by `1e6` to get the USDC value.

## Step 9 — Run one-time approvals

The `setup_approvals` task grants the two exchanges permission to pull USDC and CTF shares from the EOA. Idempotent — safe to re-run.

The task is deployed with `authentication: "auth_token"` (`compose.yaml:28`, `:34`), so it must be called via HTTP with the token from Step 6. `goldsky compose callTask` only works against local servers, not the deployed app.

```bash
curl -X POST \
  -H "Authorization: Bearer $COMPOSE_TOKEN" \
  "https://api.goldsky.com/api/admin/compose/v1/<app name>/tasks/setup_approvals"
```

Expect 4 sponsored on-chain transactions (USDC approval × 2 exchanges, CTF `setApprovalForAll` × 2 exchanges). Tail `goldsky compose logs` to confirm.

## Step 10 — Optional: publish to a new GitHub repo

```bash
git init
git add .
git commit -m "Initial commit: Compose copy-trader"
gh repo create <user's repo name> --<public|private> --source=. --push
```

## Step 11 — Smoke test

**Option A — synthetic webhook.** Post a fake `OrderFillRow` to the `copy_trade` endpoint. Expect a `MARKET_NOT_FOUND` response (webhook auth passed, market lookup failed on the fake tokenId — this proves the wiring). Example:

```bash
curl -X POST \
  -H "Authorization: Bearer $COMPOSE_TOKEN" \
  -H "Content-Type: application/json" \
  https://api.goldsky.com/api/admin/compose/v1/<app name>/tasks/copy_trade \
  -d '{"id":"test-1","block_number":1,"log_index":0,"transaction_hash":"0xtest","block_timestamp":"2026-01-01T00:00:00Z","maker":"<one watched wallet lowercase>","taker":"0x0000000000000000000000000000000000000000","maker_asset_id":"0","taker_asset_id":"999","maker_amount":1,"taker_amount":1,"fee":0}'
# → expect status: "MARKET_NOT_FOUND"
```

**Option B — live test.** Tail Compose logs and wait for a real fill on a watched wallet:

```bash
goldsky compose logs
```

Look for `[copy_trade] TRADE_EXECUTED: BUY <market> — order <id>` or a `BALANCE_LOW` / `MARKET_CLOSED` skip reason. Either means the system is working end-to-end.

Also tail pipeline logs to confirm fills are being forwarded:

```bash
goldsky turbo logs polymarket-ctf-events
```

## Troubleshooting

- **Webhook returns 401.** `COMPOSE_WEBHOOK_AUTH` secret is wrong or missing. Re-create it per Step 6, making sure the token is a valid Compose API token and the JSON is correctly escaped.
- **Webhook returns 404.** Pipeline URL path segment doesn't match the deployed app name. Check pipeline YAML line 76.
- **`copy_trade` returns `BALANCE_LOW`.** EOA has less than $1.10 USDC.e. Top up.
- **`copy_trade` returns `MARKET_NOT_FOUND` for real fills.** Token ID from pipeline doesn't resolve in Gamma — likely a stale or non-CTF token. Check the fill manually on Polymarket.
- **`copy_trade` returns `TRADE_FAILED: ... geo-block`.** `CLOB_HOST` is not routing through the EU. Re-check line 20 of `compose.yaml`; try a fresh deploy of a private proxy.
- **Pipeline runs but no webhooks arrive.** `WATCHED_WALLETS` addresses in pipeline YAML don't match on-chain fills — check casing (must be lowercase) and formatting.
- **`setup_approvals` runs but trades still revert `TRANSFER_FROM_FAILED`.** The EOA has approvals but the approvals were done on an older wallet address, or the user swapped `PRIVATE_KEY` after approvals. Re-run `setup_approvals` with the current key.
- **Redeem cron doesn't claim winnings.** Check logs for `[redeem] N redeemable positions`. If 0, there may be no resolved markets with balance; wait. If >0 but txs fail, likely a CTF approval issue — re-run `setup_approvals`.

## What you should NOT do

- Do not put the private key anywhere other than the `PRIVATE_KEY` secret. Do not add it to `.env`, do not pass it on the command line except via `goldsky compose secret set`, do not log it.
- Do not change `CHAIN_ID` in `src/lib/types.ts:9` or the contract addresses at lines 3–6. Polymarket lives on Polygon mainnet only.
- Do not change the `redeem` cron cadence (`compose.yaml:40`) to be more frequent than every 5 minutes. Polymarket's data API is the source of truth and responses are cached; hammering it hurts more than it helps.
- Do not delete the `COMPOSE_WEBHOOK_AUTH` secret to rotate it — other pipelines in the same project may depend on it. Create a new one with a different name and update pipeline YAMLs individually.
- Do not test with US-only proxies or try to run from a US IP without a proxy. Polymarket's CLOB will 403 and the first real fill will fail silently.
