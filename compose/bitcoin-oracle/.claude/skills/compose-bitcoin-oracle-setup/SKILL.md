---
name: compose-bitcoin-oracle-setup
description: Configure and deploy this Compose bitcoin-oracle example under the user's own Goldsky account. A cron task (default every minute) fetches BTC/USD from CoinGecko and writes `(timestamp, price)` as `bytes32` values to an on-chain `PriceOracle` contract. Walks a new user through CLI install, providing or deploying a PriceOracle-shaped contract (the example ships only the ABI, not Solidity source), wiring the contract address and chain into the task, optional GitHub publishing, and a log-tailing smoke test. Use when a user has just cloned this example or asks to set up / deploy / configure the bitcoin-oracle app.
---

# Setup: Compose bitcoin-oracle

This skill makes the cloned bitcoin-oracle example runnable under the user's own Goldsky account. Every minute, the task fetches BTC/USD from CoinGecko and writes `(timestamp, price * 100)` as two `bytes32` values to a `PriceOracle` contract via a Compose-managed wallet. It also appends the price to a Compose `collection` for historical queries.

Assume the user has never used Goldsky Compose before. Do not skip preflight.

## Non-negotiables

- **Never run `forge create`, `goldsky compose deploy`, `git push`, or `gh repo create` without showing the exact command first and getting explicit confirmation.**
- **The example ships only `src/contracts/PriceOracle.json` (the ABI), not a `.sol` source file.** The user must either (a) bring an existing contract on any EVM chain that matches this ABI and whitelist the Compose wallet as writer, or (b) deploy a fresh `PriceOracle` — in which case you'll provide the reference Solidity below.
- **Three values in `src/tasks/bitcoin-oracle.ts` must be consistent with each other: the contract address (line 5), the chain (line 15), and the access-control state on that contract.** If the contract has an `onlyOwner`/authorized-writer modifier, the Compose wallet must be the authorized writer; otherwise every `write()` reverts.
- **Do not touch `src/lib/utils.ts`.** `toBytes32` is coupled to how the contract stores the value.

## Variable handling for agents

When this skill says `$FOO`, capture the literal value from the prior command's output and substitute it directly into the next command. Do not rely on shell variables persisting between separate Bash tool invocations — each invocation gets a fresh shell with no env carryover from earlier commands.

## Preflight

1. **`goldsky` CLI** — `goldsky --version`. Install per https://docs.goldsky.com/reference/cli.
2. **`goldsky` authenticated** — `goldsky project list`. If it errors, stop and tell the user: "Please run `goldsky login` in your terminal — browser flow. Tell me to continue when you see the success message." Do not spawn `goldsky login` from Bash; it requires an interactive browser.
3. **`deno`** — `deno --version`. `curl -fsSL https://deno.land/install.sh | sh` if missing.
4. **`foundry`** — `forge --version`. Only needed if the user is deploying a fresh `PriceOracle`.

## Step 1 — Configuration interview

1. **"App name?"** (default: `bitcoin-oracle`) → top-level `name:` field in `compose.yaml`.
2. **"Which chain?"** (default: `polygonAmoy`) — any EVM chain supported by Compose. Common options: `base`, `baseSepolia`, `polygon`, `polygonAmoy`, `arbitrum`, `optimism`, `ethereum`. Use the camelCase form in TS code.
3. **"How often should the cron run?"** (default: `* * * * *`, every minute) — the `expression:` under the `cron` trigger in `compose.yaml`.
4. **"Do you already have a `PriceOracle`-shaped contract on that chain, or should we deploy a fresh one?"**
   - The shared demo at `0x34a264BCD26e114eD6C46a15d0A3Ba1873CaA708` on Polygon Amoy is **not a viable option** for their own setup — it's shared testnet infra.
   - "Bring your own" path: they provide the contract address and will whitelist the Compose wallet as writer (via a `setWriter`-style method or redeploy with the right owner/role).
   - "Deploy fresh" path: they use the reference Solidity in Step 3.
5. **"Publish to a new GitHub repo?"** — optional.

## Step 2 — Provision the Compose wallet

The wallet is named `bitcoin-oracle-wallet` (matches the `name:` in the `evm.wallet({ name: "bitcoin-oracle-wallet" })` call inside `src/tasks/bitcoin-oracle.ts`). Provision it and print its address:

```bash
goldsky compose wallet create bitcoin-oracle-wallet
```

Save the printed address as `$COMPOSE_WALLET`.

## Step 3 — Contract: bring-your-own OR deploy fresh

**Branch A — Bring your own contract.** Ask the user to:
1. Confirm their contract matches the ABI in `src/contracts/PriceOracle.json` (function `write(bytes32,bytes32)`, view `latestTimestamp()`, view `latestPrice()`, event `PriceUpdated(indexed bytes32, bytes32)`).
2. Grant the Compose wallet write permission on the contract (`setWriter($COMPOSE_WALLET)` or equivalent from the contract's owner EOA).
3. Give you the contract address as `$CONTRACT_ADDRESS`.

**Branch B — Deploy fresh.** The example doesn't ship a `.sol` source file, and the example directory has no `contracts/` subdirectory. Run `mkdir -p contracts` first, then write this minimal reference contract to `contracts/PriceOracle.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract PriceOracle {
    address public writer;
    bytes32 public latestTimestamp;
    bytes32 public latestPrice;

    event PriceUpdated(bytes32 indexed timestamp, bytes32 price);

    error OnlyWriter();

    constructor(address _writer) { writer = _writer; }

    function setWriter(address newWriter) external {
        if (msg.sender != writer) revert OnlyWriter();
        writer = newWriter;
    }

    function write(bytes32 timestamp, bytes32 price) external {
        if (msg.sender != writer) revert OnlyWriter();
        latestTimestamp = timestamp;
        latestPrice = price;
        emit PriceUpdated(timestamp, price);
    }
}
```

Then output this command — user runs it with their own funded EOA:

```bash
forge create contracts/PriceOracle.sol:PriceOracle \
  --rpc-url <RPC_URL_FOR_CHOSEN_CHAIN> \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --constructor-args $COMPOSE_WALLET
```

RPC URLs:
- `polygonAmoy` → `https://rpc-amoy.polygon.technology`
- `polygon` → `https://polygon-rpc.com`
- `base` → `https://mainnet.base.org`
- `baseSepolia` → `https://sepolia.base.org`
- `arbitrum` → `https://arb1.arbitrum.io/rpc`
- `optimism` → `https://mainnet.optimism.io`

Capture `Deployed to: 0x...` — that's `$CONTRACT_ADDRESS`.

## Step 4 — Wire the contract address and chain into the task

Edit `src/tasks/bitcoin-oracle.ts` — use grep anchors:
- Find `const ORACLE_CONTRACT = "0x..."` near the top of the file and replace the address with `$CONTRACT_ADDRESS`.
- Find the `evm.chains.polygonAmoy` reference inside the `new evm.contracts.PriceOracle(...)` call and swap for `evm.chains.<chosen chain in camelCase>`.

If the user changed the cron cadence, edit the `expression:` under the `cron` trigger in `compose.yaml`.

## Step 5 — Gas: sponsorship vs funding

Compose-managed (Privy) wallets default to `sponsorGas: true` on chains where Compose covers sponsorship (Base, Base Sepolia, Polygon, Polygon Amoy, and others — verify in the Goldsky docs for your chain). On those chains, the wallet needs no funding.

If the user is on a sponsored chain: skip funding. The default is already correct.

If the user is on a non-sponsored chain: send native gas token to `$COMPOSE_WALLET`. Testnets use a faucet (Polygon Amoy: https://faucet.polygon.technology). Mainnets: budget for the cron cadence — every-minute writes on mainnet ≈ 1,440 tx/day. For a tighter budget, reduce cadence in `compose.yaml` to e.g. `*/5 * * * *` (every 5 min) before deploying.

## Step 6 — Optional: publish to a new GitHub repo

```bash
git init
git add .
git ls-files --cached | grep -iE '(keypair\.json|\.env|private[._-]?key|\.pem|id_rsa)' && \
  { echo "ABORT: secret-shaped file staged"; exit 1; }
git commit -m "Initial commit: Compose bitcoin-oracle"
gh repo create <user's repo name> --<public|private> --source=. --push
```

## Step 7 — Deploy to Goldsky

```bash
goldsky compose deploy
```

## Step 8 — Smoke test

Tail logs and wait for the next cron fire (up to 1 minute):

```bash
goldsky compose logs
```

Good output is a return payload with `success: true` and an `oracleHash` 0x-prefixed tx hash, repeating every minute with no retries.

Verify on-chain:
- Open the contract on the appropriate explorer (e.g. `https://amoy.polygonscan.com/address/$CONTRACT_ADDRESS#events` for Polygon Amoy).
- You should see a `PriceUpdated` event every minute.
- Call `latestPrice()` and `latestTimestamp()` — both should return recent `bytes32` values.

## Troubleshooting

- **Edits to `compose.yaml` or source files don't take effect after redeploy.** The local `.compose/` bundle cache is stale. Run `rm -rf .compose/` and redeploy.
- **Every cron run fails with a revert.** The Compose wallet isn't authorized to call `write()`. In Branch A, re-run the contract owner's `setWriter($COMPOSE_WALLET)`. In Branch B, re-check the constructor arg used in `forge create` matches `$COMPOSE_WALLET`.
- **`insufficient funds for gas`.** Fund `$COMPOSE_WALLET` with native gas token on the target chain.
- **CoinGecko 429 / rate-limited.** The default retry config (3 attempts, 1s/2s backoff at `bitcoin-oracle.ts` lines 23–25) handles transient rate-limits. If it's persistent, either reduce cron cadence (e.g. `*/5 * * * *`) or switch to a paid API.
- **Task runs but no events on-chain.** Confirm the `evm.chains.*` reference in `src/tasks/bitcoin-oracle.ts` matches the chain where the contract lives. A wallet on the wrong chain signs a tx that never appears on the intended chain.

## What you should NOT do

- Do not change the `toBytes32` helper in `src/lib/utils.ts`. The contract reads `price` as `bytes32` and the example scales by 100 (cents); changing either side silently breaks the stored value.
- Do not set `Date.now() / 1000` as the timestamp. The example uses milliseconds (`Date.now()`) and the contract stores whatever it receives; just keep them consistent. If the user has a contract that expects seconds, convert, but don't "correct" the example preemptively.
- Do not reuse the shared demo contract at `0x34a264BCD26e114eD6C46a15d0A3Ba1873CaA708` as a permanent target. It's an open testnet demo that anyone can overwrite.
