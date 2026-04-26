---
name: compose-nav-oracle-setup
description: Configure and deploy this Compose nav-oracle example under the user's own Goldsky account. A cron task (default every 5 min) fetches a NAV bundle from a custodian endpoint and publishes it to ReserveAggregator contracts on Base Sepolia and Arbitrum Sepolia. Walks a new user through CLI install, deploying two instances of ReserveAggregator.sol (one per chain) with the Compose-managed publisher wallet, wiring addresses into the task, swapping the custodian URL, optionally publishing to a new GitHub repo, and the final deploy + log-tailing smoke test. Use when a user has just cloned this example or asks to set up / deploy / configure the nav-oracle app.
---

# Setup: Compose nav-oracle

This skill makes the cloned nav-oracle example runnable under the user's own Goldsky account. On a cron (default every 5 minutes) the app fetches a NAV (net asset value) bundle from a custodian HTTP endpoint, scales the values to 18-decimal fixed-point, and writes them to `ReserveAggregator` contracts on two chains in parallel via a single Compose-managed wallet.

Assume the user has never used Goldsky Compose before. Do not skip preflight.

## Non-negotiables

- **Never run `forge create`, `goldsky compose deploy`, `git push`, or `gh repo create` without showing the exact command first and getting explicit confirmation.**
- **The `publisher` constructor arg on `ReserveAggregator` must be the Compose-managed wallet address.** Anything else reverts every write with `OnlyPublisher()`. This wallet is created by Compose on first deploy — you cannot pick it; you must deploy Compose *first* to find out what it is.
- **The SALT-like detail here is the custodian's JSON schema.** If the custodian response doesn't match the `CustodianResponse` interface in `src/tasks/nav-oracle.ts` exactly (`accountName`, `asOf`, `cash`, `tbills`, `repo`, `totalNav`, `ripcord`), publishes silently drop or throw on parse.
- **Do not touch `src/lib/scaling.ts`.** The 18-decimal scaling is coupled to the contract's `decimals()` return value (also hardcoded at 18).

## Variable handling for agents

When this skill says `$FOO`, capture the literal value from the prior command's output and substitute it directly into the next command. Do not rely on shell variables persisting between separate Bash tool invocations — each invocation gets a fresh shell with no env carryover from earlier commands.

## Preflight

1. **`goldsky` CLI** — run `goldsky --version`. If missing, install per https://docs.goldsky.com/reference/cli.
2. **`goldsky` authenticated** — run `goldsky project list`. If it errors, stop and tell the user: "Please run `goldsky login` in your terminal — browser flow. Tell me to continue when you see the success message." Do not spawn `goldsky login` from Bash — it needs an interactive browser. Alternative: the user passes `--token <token>` on each command.
3. **`deno`** — run `deno --version`. Install with `curl -fsSL https://deno.land/install.sh | sh` if missing.
4. **`foundry`** — run `forge --version`. Contract deployment needs it. Install: `curl -L https://foundry.paradigm.xyz | bash && foundryup`.

## Step 1 — Configuration interview

1. **"App name?"** (default: `nav-oracle`) — becomes the top-level `name:` field in `compose.yaml` and the deploy URL path.
2. **"Which two chains?"** (default: `baseSepolia` + `arbitrumSepolia`) — this example is hardcoded to publish to two chains. If the user wants a single chain or different chains, note that in Step 3 you'll also need to edit the two `BASE_SEPOLIA_AGGREGATOR`/`ARBITRUM_SEPOLIA_AGGREGATOR` constants and the corresponding `wallet.writeContract(evm.chains.*, ...)` calls in the `Promise.allSettled([...])` block of `src/tasks/nav-oracle.ts`.
3. **"Custodian endpoint URL?"** — the HTTP endpoint that serves the NAV JSON. Default is the mock at `https://raw.githubusercontent.com/goldsky-io/documentation-examples/main/compose/nav-oracle/mock-custodian.json`. If the user is just demoing, leave it; otherwise ask for their own URL.
4. **"Feed description string for each chain?"** — human-readable label stored on-chain (e.g. `"Example RWA Fund I NAV / USD"`).
5. **"How often should the cron run?"** (default: `*/5 * * * *`) — custodian-dependent. Hourly (`0 * * * *`) is common for real PoR feeds.
6. **"Publish to a new GitHub repo?"** — optional.

## Step 2 — Provision the publisher wallet

The publisher wallet is named `nav-oracle-publisher` (matches the `name:` in the `evm.wallet({ name: "nav-oracle-publisher", sponsorGas: true })` call inside `src/tasks/nav-oracle.ts`). Provision it and print its address without needing to deploy first:

```bash
goldsky compose wallet create nav-oracle-publisher
```

Save the printed address — call it `$PUBLISHER`.

Note: **you do not need to fund this wallet.** The task passes `sponsorGas: true` to `evm.wallet({...})` in `src/tasks/nav-oracle.ts`, so Goldsky covers gas on both chains.

## Step 3 — Deploy ReserveAggregator on both chains

Output these two commands. Don't execute — the user runs them with their own funded EOA on each chain (they only need gas for the deploy tx, not for runtime).

```bash
# Base Sepolia
forge create contracts/ReserveAggregator.sol:ReserveAggregator \
  --rpc-url https://sepolia.base.org \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --constructor-args $PUBLISHER "<feed description>"

# Arbitrum Sepolia
forge create contracts/ReserveAggregator.sol:ReserveAggregator \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --constructor-args $PUBLISHER "<feed description>"
```

Each prints `Deployed to: 0x...`. Capture both — call them `$BASE_AGG` and `$ARB_AGG`.

## Step 4 — Wire aggregator addresses into the task

Edit `src/tasks/nav-oracle.ts` — use grep anchors, line numbers will drift over time:
- Find `const BASE_SEPOLIA_AGGREGATOR` and replace its address with `"$BASE_AGG"`
- Find `const ARBITRUM_SEPOLIA_AGGREGATOR` and replace its address with `"$ARB_AGG"`

If the user picked a custom custodian URL in Step 1:
- Replace the `CUSTODIAN_URL` string near the top of the file with theirs.

If the user picked different chains in Step 1, also edit:
- The two `wallet.writeContract(evm.chains.baseSepolia, ...)` and `wallet.writeContract(evm.chains.arbitrumSepolia, ...)` calls inside the `Promise.allSettled([...])` block — swap chains and (optionally) rename the constants to match.

If the user wants a custom cron cadence, edit the `expression:` under the `cron` trigger in `compose.yaml`.

## Step 5 — Optional: publish to a new GitHub repo

```bash
git init
git add .
git ls-files --cached | grep -iE '(keypair\.json|\.env|private[._-]?key|\.pem|id_rsa)' && \
  { echo "ABORT: secret-shaped file staged"; exit 1; }
git commit -m "Initial commit: Compose nav-oracle"
gh repo create <user's repo name> --<public|private> --source=. --push
```

## Step 6 — Redeploy Compose

```bash
goldsky compose deploy
```

## Step 7 — Smoke test

Tail logs and wait for the next cron fire (up to 5 min):

```bash
goldsky compose logs
```

Good output:

```
Published <accountName> NAV=$<totalNav> — base:ok, arb:ok
```

Verify on chain explorers — each aggregator contract should show a `NavUpdated` event:
- `https://sepolia.basescan.org/address/$BASE_AGG#events`
- `https://sepolia.arbiscan.io/address/$ARB_AGG#events`

Sanity-test the ripcord: if the user controls the custodian endpoint, flip `"ripcord": true` in the response JSON. Next cron fire should log `Ripcord engaged …` and skip cleanly (not an error).

## Troubleshooting

- **Edits to `compose.yaml` or source files don't take effect after redeploy.** The local `.compose/` bundle cache is stale. Run `rm -rf .compose/` and redeploy.
- **`OnlyPublisher()` revert.** `$PUBLISHER` you wired into the forge constructor doesn't match the Compose wallet. Only the address currently holding the publisher role can rotate it (`setPublisher` reverts unless `msg.sender == publisher`). If the wrong address went in at constructor time, redeploy is the only recovery path — the deployer EOA has no privileged role on the contract.
- **Task keeps logging `skipped: unconfigured`.** One of `BASE_SEPOLIA_AGGREGATOR` / `ARBITRUM_SEPOLIA_AGGREGATOR` is still the zero address. Re-check `src/tasks/nav-oracle.ts` lines 22–23.
- **Custodian fetch fails with JSON parse error.** The custodian response does not match the `CustodianResponse` shape. All seven fields are required; `cash`/`tbills`/`repo`/`totalNav` must be JSON numbers (not strings), `asOf` must be ISO 8601, `ripcord` must be boolean.
- **Both `baseSepolia` and `arbitrumSepolia` writes fail.** The task throws and the retry config kicks in (2 attempts, 2s/4s backoff). If it persists, check `https://sepolia.basescan.org/address/$BASE_AGG` for recent state — the contract may be self-destructed, paused by a bad `setPublisher`, or on the wrong chain.
- **One chain's write succeeds, the other fails.** This is tolerated by design (`Promise.allSettled`). Next cron cycle reconciles. Only worry if failures are persistent on one side — likely an RPC or aggregator-specific issue.

## What you should NOT do

- Keep `sponsorGas: true` on the `evm.wallet({...})` call. Managed (Privy) wallets default to `true` already; the explicit setting is for clarity. Do not flip it to `false` — the publisher would then need native gas on both chains.
- Do not change `toScaled18` in `src/lib/scaling.ts` or the `decimals()` return on the contract. They're coupled.
- Do not add historical round support to `ReserveAggregator.sol` as part of setup — the README notes this is a demo simplification. If the user asks for it, that's a separate change, not setup.
- Do not add a `PRIVATE_KEY` secret. The publisher is a Compose-managed wallet with gas sponsorship; the user's EOA is only used once, for `forge create`.
