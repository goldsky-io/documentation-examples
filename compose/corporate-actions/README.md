# Compose Corporate-Actions Distributor

A [Compose](https://docs.goldsky.com/compose/introduction) example that pays N holders pro-rata for a tokenized corporate action — dividend, coupon, rebate, airdrop — idempotently and durably, with a tamper-evident on-chain audit trail. Aimed at institutional-finance audiences (Broadridge, DTCC, tokenization platforms): the unsexy infrastructure piece every payout system has to get right.

The interesting bit: **compose orchestrates Goldsky Turbo as an ephemeral, on-demand subroutine.** When a campaign is declared, the compose app spawns a one-shot [job-mode](https://docs.goldsky.com/turbo-pipelines/job-mode) Turbo pipeline to snapshot share-token holders at the operator-supplied record block, waits for it to finish, reads the snapshot, pays each holder, and deletes the pipeline. No always-on indexing.

## How It Works

```
                                              ┌──────────────────────────┐
       Operator                                │ Compose Hosted Neon DB   │
       POST                                    │ (auto-provisioned)       │
          │                                    │                          │
          ▼                                    │  ┌─────────────────────┐ │
┌──────────────────┐                           │  │ share_balances_<id> │◄│── Turbo job-mode pipeline
│ declare_campaign │  ① approve + declare      │  │ (account, balance)  │ │   spawned per campaign
│   (HTTP task)    │  ② spawn Turbo pipeline   │  └─────────────────────┘ │   Source: erc20_transfers
└────────┬─────────┘     (one-shot, bounded)   │     ↑ checkpoint flush   │   filter: shareToken
         │                                     └─────┼────────────────────┘   end_block: recordBlock
         ▼                                           │
┌──────────────────┐                                 │
│ DistributionCamp │                          ┌──────┴───────────┐
│  (per chain)     │                          │ process_campaigns│ poll /state
└────────┬─────────┘                          │   (cron, /1 min) │ every 5s
         │ HolderPaid                         └────────┬─────────┘ until completed
         │ events                                      │
         │ ◄─── pay() per holder, 5 concurrent ◄───────┘
         │
         └──────────── on-chain audit trail
```

**The orchestration loop**

1. **Operator declares a distribution** (`POST` with `campaignId`, `recordBlock`, `totalAmount`). The HTTP task validates `recordBlock <= currentBlock`, approves USDC, and calls `DistributionCampaign.declare()` which atomically pulls the escrow.
2. **The same task spawns a job-mode Turbo pipeline** filtered to the share-token contract, bounded by `end_block: recordBlock`. Per-campaign sink tables (`share_balances_<id>`) prevent cross-campaign aggregate contamination.
3. **The cron polls the pipeline state** every 5 seconds. When Turbo transitions to `completed`, the campaign flips to `paying`.
4. **The cron reads the snapshot** from the per-campaign agg table and computes pro-rata. Floor remainder goes to the last holder so the sum equals `totalAmount` exactly.
5. **Per holder: read on-chain `isPaid()`, then call `pay()` if unpaid.** Bounded concurrency (5). The contract enforces `require(!paid[id][holder], "AlreadyPaid")` cryptographically — restart safety is structural.
6. **All paid → campaign marked complete.** The pipeline is `DELETE`d and the per-campaign tables are dropped, regardless of whether Turbo's auto-cleanup would have caught it.

## Compose features demonstrated

- **HTTP trigger + cron trigger working together** through compose's collection (HTTP enqueues metadata, cron drives state)
- **Compose orchestrating Turbo** via the v1 pipelines REST API — spawn, poll, delete from inside a task
- **Auto-provisioned hosted Neon DB** — Turbo and Compose share one Postgres, no glue code
- **Multi-step durable execution** — pod kill mid-snapshot is recovered by polling state on the next cron tick; pod kill mid-payout is recovered by re-reading on-chain `isPaid` state
- **Gas-sponsored writes** — `sponsorGas: true` means the operator wallet never holds ETH
- **Crash-safe payouts** — the contract is the sole source of truth for "did this holder get paid?"; compose's collection only stores campaign metadata

## Why operator-supplied `recordBlock`

In real corporate actions, the **record date** is set in advance and is the cutoff for who gets the payout. The snapshot is by definition backwards-looking. So the operator passes an explicit `recordBlock` (typically a block well-past finality, e.g. `currentBlock - 32`); the pipeline backfills exactly that range and commits the snapshot. There's no live "wait for finality" gate inside compose — the operator already accommodated finality when they chose the block.

(Future-dated record blocks — declare today, snapshot tomorrow — are a real corporate-action feature that's out of scope for this demo. The change is small: queue the campaign at `pending`, transition to `snapshotting` once the chain crosses `recordBlock`.)

## Prerequisites

- [Goldsky CLI](https://docs.goldsky.com/installation), authenticated against your project
- [Foundry](https://book.getfoundry.sh/getting-started/installation) for the contract deploys
- A small amount of ETH on Base mainnet for the contract deploys (~0.0005 ETH)
- A project API key for the Compose CLI (`goldsky compose deploy -t <key>`) and a separate (or same) key set as the `GOLDSKY_PROJECT_KEY` secret so the running app can manage Turbo pipelines

## Project structure

```text
corporate-actions/
├── compose.yaml                 # 1 HTTP task + 1 cron task; declares GOLDSKY_PROJECT_KEY secret
├── package.json                 # viem
├── tsconfig.json
├── foundry.toml
├── contracts/
│   ├── ShareToken.sol           # Minimal ERC-20, pre-mints to demo holders
│   ├── MockUSDC.sol             # 6-decimal mock with permissionless mint
│   └── DistributionCampaign.sol # AlreadyPaid guard, escrow, audit events
├── scripts/
│   ├── seed-holders.json        # 10 demo holder addresses, 1000 EIS each
│   └── deploy.sh                # forge create x3 in one go
└── src/
    ├── lib/
    │   ├── constants.ts         # CONFIG (single chain), pipeline naming helpers
    │   ├── types.ts             # Campaign / Holder / Payout / status machine
    │   ├── normalize.ts         # normalizeAddr() at every boundary
    │   ├── math.ts              # bigint pro-rata
    │   ├── db.ts                # Neon HTTP /sql client (via context.fetch)
    │   └── turbo.ts             # /api/v1/pipelines client + snapshot pipeline builder
    └── tasks/
        ├── declare-campaign.ts  # HTTP trigger
        └── process-campaigns.ts # Cron trigger; status-machine driver
```

## Quick start

### 1. Deploy the contracts

```bash
PRIVATE_KEY=0x... ./scripts/deploy.sh
```

The script deploys MockUSDC, ShareToken (pre-minting 1000 EIS to each of the 10 seed holders), and DistributionCampaign on Base mainnet. It prints the three addresses; copy them into `src/lib/constants.ts`.

### 2. Set the project secret

```bash
goldsky secret create GOLDSKY_PROJECT_KEY <your-cm...-project-api-key>
```

This is what the running compose app uses to spawn / poll / delete Turbo pipelines via the v1 API.

### 3. Deploy the compose app

```bash
goldsky compose deploy
```

Compose-cloud auto-provisions a hosted Neon DB and creates a project secret named `CORPORATE_ACTIONS` referencing it. The job-mode pipelines we spawn write into that DB via the same secret.

The first cron tick logs the operator wallet:

```text
Operator wallet: 0x... No active campaigns; idle.
```

### 4. Mint MockUSDC to the operator

```bash
cast send <MOCK_USDC> "mint(address,uint256)" <OPERATOR> 1000000000000 \
  --rpc-url https://mainnet.base.org --private-key $PRIVATE_KEY
```

(1,000,000 mUSDC — enough for many campaigns.)

### 5. Declare a campaign

Pick a record block roughly `currentBlock - 32` so it's safely past finality:

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

That declares a 10,000 mUSDC distribution. Within 30-90 seconds (depending on pipeline cold-start time + the small range of blocks the snapshot covers, sped up by Fast Scan), all 10 holders receive 1,000 mUSDC each.

### 6. Verify on-chain

```bash
cast call <DISTRIBUTION_CAMPAIGN> "getCampaign(bytes32)" <onChainId> \
  --rpc-url https://mainnet.base.org
```

`escrowRemaining` will be exactly 0 once all 10 holders are paid. The full audit trail is in the contract's `HolderPaid` events.

## Crash-safety walkthrough

The institutional credibility of this demo lives or dies here. The contract is the source of truth for "did this holder get paid?" — compose can crash anytime, restart anytime, never double-pay or skip a holder.

To verify yourself:

1. POST a fresh campaign (new `campaignId` so it doesn't dedup).
2. Wait 30-60 seconds. Some holders should be paid; others still pending. Check the `HolderPaid` events on the chain.
3. Pause the compose app: `goldsky compose pause`.
4. Resume: `goldsky compose resume`.
5. Within the next cron cycle, every remaining holder gets paid. **Zero duplicates** on-chain (verify by counting `HolderPaid` events for the campaign).

What's protecting you:

- **Compose's collection only stores campaign metadata** (status, declareTxHash, pipelineName). It does NOT cache per-holder paid state — there's no off-chain DB to diverge from on-chain truth.
- **Per-holder `isPaid()` check before each `pay()` call** — already-paid holders are skipped without an attempted tx.
- **Contract's `require(!paid[id][holder], "AlreadyPaid")`** — even if a stale tx arrives after restart, the contract rejects it. No double-pay possible regardless of compose's state.

A pod kill mid-snapshot is also recoverable: compose only writes the campaign row at the end of `declare_campaign`, so a death mid-task either fails the whole declaration (escrow recoverable via `seal()`) or completes it cleanly. The cron polls the pipeline state cold on the next tick.

## Customization

### Swap the share token

Update `CONFIG.shareToken` in `src/lib/constants.ts` and re-deploy the compose app. Each campaign's pipeline is generated with this address baked in, so existing campaigns are unaffected.

### Add a chain

Add a `chain` discriminator to `Campaign` and `DeclareParams`, populate `CONFIG` with a per-chain map (this used to be `CHAIN_CONFIG` in earlier iterations of this example), and pass `chain` into `buildSnapshotPipeline` so the dataset name (`base.erc20_transfers` vs `arbitrum.erc20_transfers`) is parameterized.

### Change cadence or polling

Edit `compose.yaml`'s cron expression and `STATE_POLL_INTERVAL_MS` in `constants.ts`. Lower polling = faster perceived liveness, more API calls.

### Use real USDC

Replace `MockUSDC.sol` with the real USDC address per chain in `CONFIG.payToken`. Real USDC isn't fee-on-transfer, so `escrowRemaining` math is exact.

## When NOT to use this pattern

This is **push-based pro-rata** — bounded by the gas-sponsored bundler's throughput (~1-5 userOps/sec per sender). At >100 holders the cron loop overlaps cycles; at >1000 it's the wrong shape entirely. Production-scale distributions (Apple has millions of shareholders) use **merkle-claim contracts** instead — operator publishes one root, holders pull.

This example demonstrates orchestration, idempotency, and audit-trail primitives that apply to either model. The on-chain shape changes; the compose plumbing doesn't.

## Resources

- [Compose introduction](https://docs.goldsky.com/compose/introduction)
- [Turbo job-mode pipelines](https://docs.goldsky.com/turbo-pipelines/job-mode)
- [Turbo postgres_aggregate sink](https://docs.goldsky.com/turbo-pipelines/sinks/postgres-aggregate)
- [CMTAT IncomeVault](https://github.com/CMTA/IncomeVault) — Swiss-bank reference impl for tokenized-equity dividends; our event schema is anchored on this convention
- [ERC-1726 Dividend-Paying Token](https://github.com/Roger-Wu/erc1726-dividend-paying-token)
- [GitHub repository](https://github.com/goldsky-io/documentation-examples/tree/main/compose/corporate-actions)
