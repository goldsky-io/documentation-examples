---
name: compose-solana-transactions-setup
description: Configure and deploy this Compose solana-transactions example under the user's own Goldsky account. An HTTP-triggered task fetches BTC/USD from CoinGecko and writes it to a Solana Anchor program via a PDA, using Gill through Compose's sandboxed fetch. Walks a new user through CLI install, generating and funding a Solana keypair, creating Compose secrets (`SOLANA_RPC_URL`, `SOLANA_KEYPAIR`), choosing whether to target the shared demo program on devnet or their own Anchor program (with correct discriminator + PDA seeds), optional GitHub publishing, and a smoke test that returns a real Solana transaction signature. Use when a user has just cloned this example or asks to set up / deploy / configure the solana-transactions app.
---

# Setup: Compose solana-transactions

This skill makes the cloned solana-transactions example runnable under the user's own Goldsky account. An HTTP request invokes the task, which fetches BTC/USD from CoinGecko, builds a Solana transaction (Gill + sandboxed transport), signs it with a keypair loaded from Compose secrets, and sends it to the configured Solana RPC. It also stores each price in a `bitcoin_prices` collection.

Assume the user has never used Goldsky Compose or Solana tooling before.

## Non-negotiables

- **Never run `goldsky compose deploy`, `goldsky compose secret set`, `git push`, or `gh repo create` without showing the exact command first and getting explicit confirmation.**
- **`SOLANA_KEYPAIR` must be the exact JSON byte-array format produced by `solana-keygen`** (e.g. `[12,34,56,...]`). Base58, hex, mnemonic, or any other representation will crash the task on the `JSON.parse(env.SOLANA_KEYPAIR)` call inside `src/tasks/solana-writer.ts`.
- **The keypair account must hold SOL on the same network as `SOLANA_RPC_URL`.** Devnet SOL is not mainnet SOL. Missing funds = every tx fails silently at `sendTransaction`.
- **Program ID, write discriminator, and PDA seeds are three parts of a single contract.** If the user changes the program target, all three must match the new program's IDL.
- **`authentication: "none"` (the example default in `compose.yaml`) makes the deployed task publicly callable.** Anyone with the URL can drain the keypair's SOL via repeated invocations. Acceptable for local devnet testing only. Before deploying to mainnet-beta or any non-trivial RPC, change it to `"auth_token"`.

## Variable handling for agents

When this skill says `$FOO`, capture the literal value from the prior command's output and substitute it directly into the next command. Do not rely on shell variables persisting between separate Bash tool invocations — each invocation gets a fresh shell with no env carryover from earlier commands.

## Preflight

1. **`goldsky` CLI** — `goldsky --version`. Install per https://docs.goldsky.com/reference/cli.
2. **`goldsky` authenticated** — `goldsky project list`. If it errors, stop and tell the user: "Please run `goldsky login` in your terminal — browser flow. Tell me to continue when you see the success message." Do not spawn `goldsky login` from Bash; it requires an interactive browser.
3. **`solana` CLI** — `solana --version`. Needed to generate and fund a keypair. Install: `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`.
4. **`node` + `npm`** — `npm --version`. The example has a `package.json` with `gill`; `npm install` must succeed before local `compose run`.

## Step 1 — Configuration interview

1. **"App name?"** (default: `my-solana-app`) → top-level `name:` field in `compose.yaml`.
2. **"Which Solana network?"** (default: devnet) — pick one: devnet (`https://api.devnet.solana.com`), testnet (`https://api.testnet.solana.com`), mainnet-beta (`https://api.mainnet-beta.solana.com`), or a private RPC (Helius, QuickNode, etc.). For a first-time user, strongly recommend devnet. **If the user picks mainnet-beta or a private/paid RPC, also flip the `authentication: "none"` line under the `solana_writer` task in `compose.yaml` to `authentication: "auth_token"` before Step 7's deploy** — see Non-negotiables.
3. **"Do you have your own Anchor program deployed, or should we target the shared demo program at `4MUYDek4T93NNN9dsRfxRTZc4KznZ1vTTe4vLtoS2AEs` on devnet?"**
   - Demo program is only available on devnet — it won't exist on mainnet or a custom RPC.
   - Own program path: you'll need the program ID, the 8-byte discriminator for the `write` instruction (from the IDL), and matching PDA seeds. Ask for all three.
4. **"Publish to a new GitHub repo?"** — optional.

## Step 2 — Install dependencies

```bash
npm install
```

This resolves `gill` (the Solana client library). Compose's bundler uses `node_modules/` so this is required even for remote deploys.

## Step 3 — Generate and fund a Solana keypair

```bash
solana-keygen new --outfile ./keypair.json --no-bip39-passphrase
```

This creates `keypair.json` whose contents are a JSON byte array — the exact format `SOLANA_KEYPAIR` expects.

Get the public address:

```bash
solana-keygen pubkey ./keypair.json
```

Call the address `$SOLANA_ADDRESS`. Fund it:

- **Devnet:** `solana airdrop 2 $SOLANA_ADDRESS --url devnet` (or use https://faucet.solana.com).
- **Testnet:** `solana airdrop 2 $SOLANA_ADDRESS --url testnet`.
- **Mainnet-beta / private RPC:** send SOL manually. Each write costs ~0.00025 SOL; ~0.05 SOL is plenty to start.

After funding, double-check: `solana balance $SOLANA_ADDRESS --url <network>`.

**Add `keypair.json` to `.gitignore`** before anything else — it's a private key. The example's `.gitignore` already excludes `.env`, but verify `keypair.json` is also excluded before committing.

## Step 4 — Create Compose secrets

Both secrets are declared in the `secrets:` block of `compose.yaml` as app-scoped, so create them with `goldsky compose secret set` (not the project-level `goldsky secret create`).

**Avoid putting the secret value on the command line** — `--value "<literal>"` writes the keypair into shell history (`~/.zsh_history` / `~/.bash_history`). Read it into a temporary variable in a single shell invocation so the literal never lands in history:

```bash
goldsky compose secret set SOLANA_RPC_URL --value "https://api.devnet.solana.com"

# Read the keypair into a variable and pipe it as the secret value in one shot:
SOLANA_KP_VALUE="$(cat ./keypair.json)" goldsky compose secret set SOLANA_KEYPAIR --value "$SOLANA_KP_VALUE"; unset SOLANA_KP_VALUE
```

(The RPC URL is not secret — fine on the command line.)

For local testing, also create a `.env` file (already git-ignored by the example):

```
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_KEYPAIR=[12,34,56,...paste contents of keypair.json...]
```

## Step 5 — Own-program path (skip if using demo program)

If the user brought their own program, edit `src/tasks/solana-writer.ts` — use grep anchors:

- Find `const PROGRAM_ID = "..."` and replace with the user's program ID in base58.
- Find `const WRITE_DISCRIMINATOR = new Uint8Array([...])` and replace with the 8 bytes from their IDL for the `write` instruction.
- Inside the `getProgramDerivedAddress({ programAddress: ..., seeds: [...] })` call, replace the seeds list with their program's expected seeds (default: `["data", signer_pubkey, key]`).
- Find the `instructionData` `Uint8Array` construction and the byte-offset writes (`instructionData.set(...)`) — match the user's IDL data layout (default is 8-byte discriminator + 32-byte key + 32-byte value).
- Find the `accounts: [...]` array on the `writeInstruction` object and add/remove entries to match what the program expects (default: PDA + signer + SystemProgram).

Ask for the user's IDL if they have it; point them at `anchor idl parse <path>` or their program's `target/idl/<name>.json` if using Anchor.

## Step 6 — Optional: publish to a new GitHub repo

Verify `.gitignore` excludes `keypair.json`, `.env`, and `node_modules/`, then:

```bash
git init
git add .
# Critical: keypair.json contains a real Solana private key. Abort if anything
# secret-shaped is staged. Fix the .gitignore, `git rm --cached <file>`, retry.
git ls-files --cached | grep -iE '(keypair\.json|\.env|private[._-]?key|\.pem|id_rsa)' && \
  { echo "ABORT: secret-shaped file staged"; exit 1; }
git commit -m "Initial commit: Compose solana-transactions"
gh repo create <user's repo name> --<public|private> --source=. --push
```

## Step 7 — Deploy to Goldsky

```bash
goldsky compose deploy
```

Capture the deployed task URL printed by `compose deploy` for `solana_writer` — you'll use it in Step 8 instead of constructing the URL by hand.

## Step 8 — Smoke test

The task is HTTP-triggered with `authentication: "none"` (under the `solana_writer` task in `compose.yaml`) — no token required, anyone with the URL can call it. Invoke the deployed endpoint directly:

```bash
curl -X POST "https://api.goldsky.com/api/admin/compose/v1/<app name>/tasks/solana_writer"
```

Good response:

```json
{
  "success": true,
  "signature": "<base58 tx signature>",
  "price": 97234.50,
  "timestamp": 1712345678900,
  "priceId": "..."
}
```

Verify the transaction on-chain: open `https://explorer.solana.com/tx/<signature>?cluster=devnet` (swap `cluster` for mainnet-beta as appropriate).

Note: `goldsky compose callTask` only invokes *locally running* tasks (via `goldsky compose start` with `.env` populated). Use it for local development; use curl for the deployed app.

If the task returns without a signature or throws, jump to Troubleshooting.

## Troubleshooting

- **Edits to `compose.yaml` or source files don't take effect after redeploy.** The local `.compose/` bundle cache is stale. Run `rm -rf .compose/` and redeploy.
- **`TypeError: Unexpected character in JSON` on `JSON.parse(env.SOLANA_KEYPAIR)`.** The secret isn't a JSON byte array. Re-create the secret from `cat ./keypair.json`; do not paste a base58 string.
- **`Transaction simulation failed: Attempt to debit an account but found no record of a prior credit`.** The signer account has 0 SOL. Fund it per Step 3.
- **`Blockhash not found` / stale blockhash.** The RPC is lagging or rate-limiting. For devnet, retry; for production, switch to a paid RPC (Helius, QuickNode, Triton).
- **`Program ... failed: Custom program error: 0x...`.** The program rejected the instruction. Most common cause on own-program path: wrong discriminator (Step 5 line 21) or wrong PDA seeds (line 94). Double-check against the IDL.
- **CoinGecko 429.** Retry config handles transient rate-limits. For heavier use, pay CoinGecko or swap the price source.
- **Task times out.** Solana RPC might be slow. Default commitment is `confirmed`; if the RPC is severely backed up, consider switching providers.

## What you should NOT do

- Do not commit `keypair.json` or `.env`. Both are in `.gitignore`; verify before any `git add`.
- Do not change `createSandboxedTransport` in `solana-writer.ts` unless the user explicitly wants to use a Solana library other than Gill. The pattern intentionally routes all RPC traffic through Compose's sandboxed fetch for auditability.
- Do not leave `authentication: "none"` on a production deploy — see Non-negotiables for the drain risk.
- Do not hardcode the RPC URL in source. `env.SOLANA_RPC_URL` already takes precedence over the `DEVNET_RPC_URL` fallback (line 62); keep it that way so swapping networks is a secret change, not a code change.
