# Compose Corporate-Actions Distributor

A [Compose](https://docs.goldsky.com/compose/introduction) example that pays N holders pro-rata for a tokenized corporate action — dividend, coupon, rebate, airdrop — idempotently and durably, with a tamper-evident on-chain audit trail. The interesting bit: **compose orchestrates Goldsky Turbo as an ephemeral, on-demand subroutine.** Declaring a campaign spawns a one-shot [job-mode](https://docs.goldsky.com/turbo-pipelines/job-mode) pipeline to snapshot share-token holders at the operator-supplied record block; compose waits for it to finish, pays each holder, then deletes the pipeline. No always-on indexing.

## How it works

```
   Operator                                  ┌──────────────────────────┐
   POST                                      │ Compose Hosted Neon DB   │
      │                                      │ (auto-provisioned)       │
      │                                      │                          │
      ▼                                      │  ┌─────────────────────┐ │
┌──────────────────┐                         │  │ share_balances_<id> │◄┼─ Turbo job-mode pipeline
│ declare_campaign │  ① approve + declare    │  │ (raw Transfer rows) │ │   spawned per campaign
│   (HTTP task)    │  ② spawn Turbo pipeline │  └─────────────────────┘ │   filter: address + block
│                  │  ③ poll /state · 2s     │     ▲ checkpoint flush   │           range
│                  │  ④ pay() each holder    └─────┼────────────────────┘
│                  │  ⑤ check escrowRemaining      │
└────────┬─────────┘  ⑥ DELETE pipeline            │
         │
         ▼
┌──────────────────┐
│ DistributionCamp │   ◄─── pay() per holder, 25 concurrent
│  (on Base)       │   ───► HolderPaid events (on-chain audit)
└──────────────────┘
```

**One HTTP request drives the entire lifecycle.** No cron, no off-chain handoff:

1. **Operator declares a distribution** (`POST` with `campaignId`, `recordBlock`, `totalAmount`). The task validates `recordBlock <= currentBlock`, approves USDC, calls `DistributionCampaign.declare()` (atomically pulls escrow).
2. **The same task spawns a job-mode Turbo pipeline** filtered to the share-token contract over `block_number BETWEEN <deployBlock> AND <recordBlock>` — the planner prunes everything outside that window. The sink writes raw `Transfer` rows into a per-campaign Postgres table (`share_balances_<id>`).
3. **It polls `/state` every 2 seconds** until the pipeline reports `completed` (or its k8s deployment auto-cleans up, which we infer from `state=unknown` + the table having rows).
4. **It reads the snapshot** with a SQL aggregate over the raw rows — `SUM(credits) − SUM(debits)` per account. Pro-rata: each holder gets `floor(balance × totalAmount / totalSupply)`, with the floor remainder assigned to the last holder so the sum equals `totalAmount` exactly.
5. **It fires up to 25 sponsored `pay()` calls concurrently** via `Promise.allSettled`. Already-paid holders are filtered out by an on-chain `isPaid()` read first; the contract's `require(!paid[id][holder])` guard means duplicates are structurally impossible anyway.
6. **It re-reads `escrowRemaining` on-chain** to confirm completion. Zero → mark campaign `complete`, `DELETE` the pipeline, drop the per-campaign table. Non-zero → leave the campaign in `paying` so a re-POST of the same `campaignId` resumes from where it left off.

Reposting the same `campaignId` after any kind of failure picks up cleanly — the contract is the sole source of truth for "did this holder get paid?", so compose's state machine never has to.

## Compose features demonstrated

- **Compose orchestrating Turbo** via the v1 pipelines REST API — spawn, poll, delete, all from inside a task
- **Multi-step durable execution** in a single HTTP request — declare → snapshot → pay → cleanup, observable end-to-end timing
- **Auto-provisioned hosted Neon DB** — Turbo and Compose share one Postgres, no glue code
- **Gas-sponsored writes** — `sponsorGas: true` so the operator wallet never holds ETH
- **Resumable on `campaignId`** — re-POST drives the existing campaign forward instead of double-declaring
- **Crash-safe payouts** — re-reading on-chain `isPaid` + the contract's `AlreadyPaid` guard mean compose can crash and restart at any point with zero risk of double-pay

## Why operator-supplied `recordBlock`

In real corporate actions, the **record date** is set in advance and is the cutoff for who gets the payout. The snapshot is by definition backwards-looking. So the operator passes an explicit `recordBlock` (typically a block past finality, e.g. `currentBlock - 32`); the pipeline backfills exactly that range and commits the snapshot. There's no live "wait for finality" gate inside compose — the operator already accommodated finality when they chose the block.

(Future-dated record blocks — declare today, snapshot tomorrow — are a real corporate-action feature that's out of scope for this demo.)

## Prerequisites

- [Goldsky CLI](https://docs.goldsky.com/installation), authenticated against your project
- [Foundry](https://book.getfoundry.sh/getting-started/installation) for the contract deploys
- A small amount of ETH on Base mainnet for the contract deploys (~0.0005 ETH)
- A project API key for the Compose CLI (`goldsky compose deploy -t <key>`) and a separate (or same) key set as the `GOLDSKY_PROJECT_KEY` secret so the running app can manage Turbo pipelines

## Project structure

```text
corporate-actions/
├── compose.yaml                 # 1 HTTP task; declares GOLDSKY_PROJECT_KEY secret
├── package.json                 # viem
├── tsconfig.json
├── foundry.toml
├── contracts/
│   ├── ShareToken.sol           # Minimal ERC-20, pre-mints to demo holders
│   ├── MockUSDC.sol             # 6-decimal mock with permissionless mint
│   └── DistributionCampaign.sol # AlreadyPaid guard, escrow, audit events
├── scripts/
│   ├── seed-holders.json        # 25 demo holder addresses, uneven amounts
│   └── deploy.sh                # forge create x3 in one go
└── src/
    ├── lib/
    │   ├── constants.ts         # CONFIG, polling cadence, concurrency
    │   ├── types.ts             # Campaign / Holder / Payout / status machine
    │   ├── normalize.ts         # normalizeAddr() at every boundary
    │   ├── math.ts              # bigint pro-rata
    │   ├── db.ts                # Neon HTTP /sql client (via context.fetch)
    │   ├── turbo.ts             # /api/v1/pipelines client + snapshot pipeline builder
    │   └── driver.ts            # state-machine driver: snapshot → paying → complete
    └── tasks/
        └── declare-campaign.ts  # HTTP trigger; drives full lifecycle inline
```

## Quick start

### 1. Deploy the contracts

```bash
PRIVATE_KEY=0x... ./scripts/deploy.sh
```

Deploys MockUSDC, ShareToken (pre-minting to the 25 seed holders), and DistributionCampaign on Base mainnet. Prints the three addresses and the ShareToken deploy block; copy them into `src/lib/constants.ts`.

### 2. Set the project secret

```bash
goldsky secret create GOLDSKY_PROJECT_KEY <your-cm...-project-api-key>
```

This is what the running compose app uses to spawn / poll / delete Turbo pipelines.

### 3. Deploy the compose app

```bash
goldsky compose deploy
```

Compose-cloud auto-provisions a hosted Neon DB and creates a project secret named `CORPORATE_ACTIONS` pointing at it. The job-mode pipelines write into that DB via the same secret.

### 4. Mint MockUSDC to the operator

The operator wallet address is printed in the compose app's logs on first request. Mint a generous amount for many campaigns:

```bash
cast send <MOCK_USDC> "mint(address,uint256)" <OPERATOR> 1000000000000 \
  --rpc-url https://mainnet.base.org --private-key $PRIVATE_KEY
```

(1,000,000 mUSDC.)

### 5. Declare a campaign

Pick a record block past finality:

```bash
RECORD_BLOCK=$(cast block-number --rpc-url https://mainnet.base.org)
RECORD_BLOCK=$((RECORD_BLOCK - 32))

curl -sX POST "https://api.goldsky.com/api/admin/compose/v1/corporate-actions/tasks/declare_campaign" \
  -H "content-type: application/json" \
  -H "Authorization: Bearer $GOLDSKY_TOKEN" \
  -d "{
    \"campaignId\":  \"0x000000000000000000000000000000000000000000000000000000000000c0a1\",
    \"recordBlock\": $RECORD_BLOCK,
    \"totalAmount\": \"10000000000\"
  }"
```

That declares a 10,000 mUSDC distribution. The request stays open for ~10-30 seconds while compose snapshots, computes pro-rata, and fires the 25 `pay()` calls in a single batch. The response body includes the final campaign state (`complete` on the happy path, or `paying` if it needs another drive call).

### 6. Verify on-chain

```bash
cast call <DISTRIBUTION_CAMPAIGN> "getCampaign(bytes32)" <onChainId> \
  --rpc-url https://mainnet.base.org
```

`escrowRemaining` will be exactly 0 once all 25 holders are paid. The full audit trail is in the contract's `HolderPaid` events.

## Crash-safety walkthrough

The contract is the source of truth for "did this holder get paid?" — compose can crash anytime, restart anytime, never double-pay or skip a holder.

To verify yourself:

1. POST a fresh campaign (new `campaignId`).
2. Mid-flight, pause the compose app: `goldsky compose pause`.
3. Resume: `goldsky compose resume`.
4. Re-POST the same `campaignId`. Within a single drive call, every remaining holder gets paid. **Zero duplicates** on-chain — verify by counting `HolderPaid` events for the campaign.

What's protecting you:

- **Compose's collection only stores campaign metadata** (status, declareTxHash, pipelineName, persisted payouts). It does NOT cache per-holder paid state — there's no off-chain DB to diverge from on-chain truth.
- **Per-holder `isPaid()` check before each `pay()` call** — already-paid holders are skipped before the tx is even attempted.
- **Contract's `require(!paid[id][holder], "AlreadyPaid")`** — even if a stale tx arrives after restart, the contract rejects it. No double-pay possible regardless of compose's state.

A pod kill mid-snapshot is also recoverable: re-POSTing the same `campaignId` polls the existing pipeline (or, if it auto-cleaned up after success, infers completion from the agg table having rows).

## Customization

### Swap the share token

Update `CONFIG.shareToken` + `CONFIG.shareTokenDeployBlock` in `src/lib/constants.ts` and re-deploy the compose app. Each campaign's pipeline bakes in the address at declare time, so existing campaigns are unaffected.

### Add a chain

Add a `chain` discriminator to `Campaign` and `DeclareParams`, populate `CONFIG` with a per-chain map, and pass `chain` into `buildSnapshotPipeline` so the dataset name (`base.erc20_transfers` vs `arbitrum.erc20_transfers`) is parameterized.

### Use real USDC

Replace `MockUSDC.sol` with the real USDC address per chain in `CONFIG.payToken`. Real USDC isn't fee-on-transfer, so `escrowRemaining` math is exact.

## When NOT to use this pattern

This is **push-based pro-rata** — bounded by the gas-sponsored bundler's throughput (~1-5 userOps/sec per sender). Up to ~100 holders in a single request is comfortable; beyond that, the right shape is **merkle-claim contracts** instead: operator publishes one root, holders pull. The compose plumbing (orchestrating Turbo, computing the snapshot, audit trail) carries over to either model — only the on-chain shape changes.

## Resources

- [Compose introduction](https://docs.goldsky.com/compose/introduction)
- [Turbo job-mode pipelines](https://docs.goldsky.com/turbo-pipelines/job-mode)
- [CMTAT IncomeVault](https://github.com/CMTA/IncomeVault) — Swiss-bank reference impl for tokenized-equity dividends; our event schema is anchored on this convention
- [ERC-1726 Dividend-Paying Token](https://github.com/Roger-Wu/erc1726-dividend-paying-token)
- [GitHub repository](https://github.com/goldsky-io/documentation-examples/tree/main/compose/corporate-actions)
