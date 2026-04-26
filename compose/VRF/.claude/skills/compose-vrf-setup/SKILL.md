---
name: compose-vrf-setup
description: Configure and deploy this Compose VRF example under the user's own Goldsky account. Walks a new user through installing the Goldsky CLI, deploying their own RandomnessConsumer contract (or reusing the shared demo), wiring the contract address into code, optionally publishing to a new GitHub repo, and deploying to Goldsky. Use when a user has just cloned this example or asks to set up / deploy / configure the VRF app.
---

# Setup: Compose VRF

This skill makes the cloned VRF example runnable under the user's own Goldsky account. The app listens for a `RandomnessRequested` event on an EVM contract, fetches verifiable randomness from drand, and writes it back on-chain via `fulfillRandomness`.

Assume the user has never used Goldsky Compose before. Do not skip preflight checks.

## Non-negotiables

- **Never run `forge create`, `goldsky compose deploy`, `git push`, or `gh repo create` without showing the exact command first and getting explicit confirmation.** Output the command, wait.
- **The authorized fulfiller on the contract must be the Compose-managed wallet.** Getting this wrong is the #1 failure mode. The contract rejects `fulfillRandomness` from any other address.
- **Three files share the same contract address.** If the user changes it, change all three.

## Variable handling for agents

When this skill says `$FOO`, capture the literal value from the prior command's output and substitute it directly into the next command. Do not rely on shell variables persisting between separate Bash tool invocations — each invocation gets a fresh shell with no env carryover from earlier commands.

## Preflight

Run these checks in order. Stop and resolve each before moving on.

1. **`goldsky` CLI installed.** Run `goldsky --version`. If missing:
   - macOS/Linux: `curl https://goldsky.com/install.sh | sh`
   - Or point the user to https://docs.goldsky.com/reference/cli
2. **`goldsky` authenticated.** Run `goldsky project list`. If it errors with auth, stop and tell the user: "Please run `goldsky login` in your terminal — it will open a browser. When you see the success message, tell me to continue." Do not spawn `goldsky login` from the agent's Bash tool — it requires an interactive browser flow you can't drive. As an alternative, the user can pass a CLI auth token via `--token <token>` on each command (token created in the Goldsky dashboard).
3. **`deno` installed** (Compose runs on Deno locally). Run `deno --version`. If missing: `curl -fsSL https://deno.land/install.sh | sh`.
4. **`foundry` installed** (only if the user will deploy their own contract). Run `forge --version`. If missing, give them the install command but don't run it: `curl -L https://foundry.paradigm.xyz | bash && foundryup`.

## Step 1 — Configuration interview

Ask the user these questions in order. Don't batch them — let each answer inform the next.

1. **"What do you want to name this app?"** (default: `compose-vrf`) — this becomes the value at `compose.yaml:1` and also the path segment in the deploy URL.
2. **"Which chain are you targeting?"** (default: `base_sepolia`) — accept any EVM chain Compose supports. Common options: `base_sepolia`, `base`, `ethereum`, `arbitrum`, `optimism`, `polygon`. Use the `evm.chains.<name>` camelCase form in the TS code (e.g. `baseSepolia`) and the `snake_case` form in `compose.yaml` (e.g. `base_sepolia`).
3. **"Do you already have your own `RandomnessConsumer`-style contract deployed, or do you want to deploy a fresh one from this example?"**
   - The shared demo contract at `0xE05Ceb3E269029E3bab46E35515e8987060D1027` is **not an option**. Its fulfiller address is fixed at deploy time; they can't whitelist their Compose wallet on it.
   - "Bring your own" path: the user has a contract they control where they can set the Compose wallet as the authorized fulfiller (via a `setFulfiller`-style method or by redeploying with the right constructor arg). Ask for the address.
   - "Deploy fresh" path: the user runs `forge create` with `contracts/RandomnessConsumer.sol` in Step 3 below.
4. **"Do you want to publish this to a new GitHub repo?"** — optional. If yes, ask for repo name and whether it should be public or private.

## Step 2 — Fetch the Compose-managed wallet address

The contract's constructor takes the authorized fulfiller address. That has to be the Compose wallet, not the user's own EOA. So we need the wallet address *before* deploying the contract.

The fulfiller wallet's name is `randomness-fulfiller` (see `src/tasks/fulfill-randomness.ts:31`). Provision it and print its address:

```bash
goldsky compose wallet create randomness-fulfiller
```

Save the printed address — call it `$COMPOSE_WALLET`.

## Step 3 — Get the contract address

**Branch A — Bring-your-own contract.** Ask the user to run their contract's fulfiller-authorization method with `$COMPOSE_WALLET` (e.g. `cast send <contract> "setFulfiller(address)" $COMPOSE_WALLET --rpc-url <RPC> --private-key $PRIVATE_KEY`). Confirm the write succeeded on the explorer. Then capture the contract address as `$CONTRACT_ADDRESS` and jump to Step 4.

**Branch B — Deploy fresh from this example.** Output this command for the user, substituting their chain's RPC URL and the wallet address from Step 2. Do **not** execute it — the user must run it with their own funded private key.

```bash
forge create contracts/RandomnessConsumer.sol:RandomnessConsumer \
  --rpc-url <RPC_URL_FOR_CHOSEN_CHAIN> \
  --private-key $PRIVATE_KEY \
  --constructor-args $COMPOSE_WALLET \
  --broadcast
```

RPC URLs for common chains:
- `base_sepolia` → `https://sepolia.base.org`
- `base` → `https://mainnet.base.org`
- `arbitrum_sepolia` → `https://sepolia-rollup.arbitrum.io/rpc`
- `optimism_sepolia` → `https://sepolia.optimism.io`

Tell the user `$PRIVATE_KEY` must be an EOA with gas on the target chain. After the command succeeds, it prints `Deployed to: 0x...`. Ask the user for that address — call it `$CONTRACT_ADDRESS`.

## Step 4 — Wire the contract address and chain into code

Three files must stay in sync. Make these edits:

**`compose.yaml`** (lines 1, 24–27):
- Line 1: `name: "<user's app name>"`
- Line 24: `network: "<chosen chain in snake_case>"`
- Line 25: `contract: "<CONTRACT_ADDRESS>"`

**`src/tasks/fulfill-randomness.ts`**:
- Line 10: `const CONTRACT_ADDRESS = "<CONTRACT_ADDRESS>";`
- Line 36: `evm.chains.<chosen chain in camelCase>`

**`src/tasks/request-randomness.ts`**:
- Line 3: `const CONTRACT_ADDRESS = "<CONTRACT_ADDRESS>";`
- Line 18: `evm.chains.<chosen chain in camelCase>`

Show a diff before applying, then apply with Edit.

## Step 5 — Funding (skip on sponsored chains)

Compose-managed (Privy) wallets default to `sponsorGas: true`, so on chains where Compose covers sponsorship (including Base Sepolia) the wallet needs no funding. Skip this step unless Step 8's smoke test fails with `insufficient funds for gas`.

If your chain isn't sponsored: send a small amount of native gas token to `$COMPOSE_WALLET`. For testnets use a faucet (e.g. https://www.alchemy.com/faucets/base-sepolia for Base Sepolia).

## Step 6 — Optional: publish to a new GitHub repo

Only if the user said yes in Step 1.

```bash
# From the example directory
git init
git add .
# Sanity-check the staging area for secret-shaped files BEFORE committing.
# Abort if any match — fix the .gitignore, run `git rm --cached <file>`, retry.
git ls-files --cached | grep -iE '(keypair\.json|\.env|private[._-]?key|\.pem|id_rsa)' && \
  { echo "ABORT: secret-shaped file staged"; exit 1; }
git commit -m "Initial commit: Compose VRF"
gh repo create <user's repo name> --<public|private> --source=. --push
```

Output commands, wait for confirmation, then run.

## Step 7 — Deploy to Goldsky

```bash
goldsky compose deploy
```

If the user chose token-based auth in preflight, append `--token $GOLDSKY_TOKEN` (using whatever variable name they stored the token in).

First deploy may take 1–2 minutes. Watch for `Deployed compose app: <app_name>` in the output. It also prints the HTTP task URLs.

## Step 8 — Smoke test

The simplest way to trigger a randomness request against the deployed app is a direct contract call. That also exercises the full event-trigger path:

```bash
cast send $CONTRACT_ADDRESS "requestRandomness()" \
  --rpc-url <RPC_URL> \
  --private-key $PRIVATE_KEY
```

Wait 10–30 seconds for Compose to pick up the event, then tail logs:

```bash
goldsky compose logs
```

You should see:
- `fetched drand round <N>`
- `fulfilled request <requestId> in tx <hash>`

Verify on-chain that the randomness was written:

```bash
cast call $CONTRACT_ADDRESS "isFulfilled(uint256)" <requestId> --rpc-url <RPC_URL>
# → 0x...01 (true)
```

Note: `goldsky compose callTask` only invokes *locally running* tasks (via `goldsky compose start`). For the deployed app, use the cast send above, or curl the `request_randomness` HTTP endpoint with a bearer token from the Goldsky dashboard.

If `isFulfilled` returns false or the logs show a revert, jump to Troubleshooting.

## Troubleshooting

- **Edits to `compose.yaml` or source files don't take effect after redeploy.** The local `.compose/` bundle cache is stale. Run `rm -rf .compose/` and redeploy.
- **`OnlyFulfiller()` revert on `fulfillRandomness`.** The contract's authorized fulfiller is not the Compose wallet. Only the address currently holding the fulfiller role can rotate it (`setFulfiller` reverts unless `msg.sender == fulfiller`). If the wrong address went in at constructor time, redeploy is the only recovery path — the deployer EOA has no privileged role on the contract.
- **Task doesn't fire when the event is emitted.** Check `compose.yaml` has the exact contract address (checksummed casing doesn't matter, but character match does) and the correct `network`. Also confirm your deploy succeeded and the trigger is active with `goldsky compose status`.
- **`insufficient funds for gas`.** `$COMPOSE_WALLET` needs native token on the target chain. Send some.
- **drand fetch fails.** The default drand endpoint is public. If drand is down, the retry config in `compose.yaml` (max 3, exponential backoff) handles transient failures. If it persistently fails, check https://api.drand.sh/chains.

## What you should NOT do

- Do not modify `src/lib/drand.ts` unless the user explicitly asks to swap drand networks. The hardcoded constants are chain-specific BLS parameters — getting them wrong breaks signature verification silently.
- Do not change the event signature `RandomnessRequested(uint256,address)` in `compose.yaml` — it must match the contract.
- Do not add a `PRIVATE_KEY` secret to this app. The Compose wallet is the signer; the user's EOA is only needed to deploy the contract, never at runtime.
