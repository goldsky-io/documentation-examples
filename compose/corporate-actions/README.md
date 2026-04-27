# Compose Corporate-Actions Distributor

A [Compose](https://docs.goldsky.com/compose/introduction) example that pays N holders pro-rata across multiple chains, idempotently and durably, with a tamper-evident on-chain audit trail. Aimed at institutional-finance audiences (Broadridge, DTCC, tokenization platforms) — the unsexy infrastructure piece every dividend / coupon / rebate / airdrop system has to get right.

This is the first compose example that crosses the Goldsky product boundary: a [Turbo pipeline](https://docs.goldsky.com/turbo-pipelines/introduction) with a `postgres_aggregate` sink keeps a running list of token holders; the compose app reads that list and pays each one.

## How It Works

```
                                            ┌──────────────────────────┐
       Operator                              │ Compose Hosted Neon DB   │
       POST                                  │ (auto-provisioned)       │
          │                                  │                          │
          ▼                                  │  ┌─────────────────────┐ │
┌──────────────────┐                         │  │   share_balances    │◄│── Turbo pipelines (one per chain)
│ declare_campaign │                         │  │ (account, balance)  │ │   Source: erc20_transfers
│   (HTTP task)    │                         │  └─────────────────────┘ │   Sink:   postgres_aggregate
└────────┬─────────┘                         │  ┌─────────────────────┐ │
         │                                   │  │ share_transfer_log  │ │
         │ approve + declare                 │  └─────────────────────┘ │
         ▼                                   └────────────▲─────────────┘
┌──────────────────┐                                      │ HTTP /sql
│ DistributionCamp │                                      │ via context.fetch
│  (per chain)     │                                      │
└────────┬─────────┘                              ┌───────┴──────────┐
         │ HolderPaid                             │ process_campaigns│
         │ events                                 │   (cron, /1 min) │
         │                                        └────────┬─────────┘
         │                                                 │ pay() per holder
         │                                                 │ (5 concurrent)
         └─────────── on-chain audit trail ◄───────────────┘
```

1. **Operator declares a distribution** (`POST` with `campaignId`, `chain`, `shareToken`, `totalAmount`). The HTTP task approves USDC and calls `DistributionCampaign.declare()` — escrow is pulled atomically.
2. **Cron task waits for finality.** It blocks until the Turbo pipeline has indexed past `recordBlock + 32` blocks for the relevant chain. This prevents stale snapshots and reorg-after-payout.
3. **Cron task reads the holder snapshot** from `share_balances` (maintained by Turbo) via the Neon HTTP query API.
4. **Pro-rata math** divides `totalAmount` proportionally to each holder's balance. The last holder absorbs the floor remainder so the sum equals `totalAmount` exactly.
5. **For each holder, cron checks on-chain `isPaid()` and calls `pay()` if not paid yet.** Bounded concurrency (5 per chain). The contract enforces `require(!paid[id][holder], "AlreadyPaid")` cryptographically — restart safety is structural.
6. **All paid → campaign marked complete.** Audit trail is the on-chain `CampaignDeclared` + N `HolderPaid` events.

## Compose Features Demonstrated

- **HTTP trigger + cron trigger working together** through compose's collection (HTTP enqueues metadata, cron processes)
- **Turbo + Compose integration via the auto-provisioned Neon DB.** Compose's hosted DB is shared with the Turbo pipelines via the `CORPORATE_ACTIONS` Goldsky secret — zero user Postgres setup
- **Multi-chain wallet** — one operator wallet writes to two chains in one task; nonces handled by compose's bundler
- **Gas-sponsored writes** — `sponsorGas: true` means the operator wallet never holds ETH
- **Crash-safe payouts** — contract is the sole source of truth for "did this holder get paid?"; compose's collection only stores campaign metadata. Pod kill mid-batch resumes cleanly via on-chain `isPaid()` check
- **Finality gate** — block payouts until the Turbo pipeline has indexed past a finality depth, so reorgs can't cause economic loss

## Prerequisites

- [Goldsky CLI](/installation) authenticated against your project
- [Foundry](https://book.getfoundry.sh/getting-started/installation) for contract deploys

## Project Structure

```text
corporate-actions/
├── compose.yaml                 # 1 HTTP task + 1 cron task
├── package.json                 # viem
├── tsconfig.json
├── contracts/
│   ├── ShareToken.sol           # Minimal ERC-20, pre-mints to test holders
│   ├── MockUSDC.sol             # 6-decimal mock with permissionless mint
│   └── DistributionCampaign.sol # AlreadyPaid guard, escrow, audit events
├── pipeline/
│   ├── base-sepolia.yaml        # erc20_transfers → postgres_aggregate
│   └── arb-sepolia.yaml         # same shape, Arbitrum Sepolia
├── scripts/
│   └── seed-holders.json        # 10 deterministic holder addresses per chain
└── src/
    ├── lib/
    │   ├── constants.ts         # CHAIN_CONFIG, FINALITY_DEPTH, CONCURRENCY
    │   ├── types.ts             # Shared interfaces
    │   ├── normalize.ts         # normalizeAddr() at every boundary
    │   ├── math.ts              # bigint pro-rata
    │   └── db.ts                # Neon HTTP /sql client (via context.fetch)
    └── tasks/
        ├── declare-campaign.ts  # HTTP trigger
        └── process-campaigns.ts # Cron trigger
```

## Quick Start

### 1. Deploy the contracts

The example expects three contracts deployed on each chain. The `seed-holders.json` file lists the 10 deterministic test addresses (`0x000…001` through `0x000…00A`); `ShareToken` pre-mints 1000 EIS to each.

```bash
# Base Sepolia
forge create contracts/MockUSDC.sol:MockUSDC \
  --rpc-url https://sepolia.base.org \
  --private-key $PRIVATE_KEY \
  --broadcast --root .

forge create contracts/ShareToken.sol:ShareToken \
  --rpc-url https://sepolia.base.org \
  --private-key $PRIVATE_KEY \
  --broadcast --root . \
  --constructor-args '[0x...001, 0x...002, ..., 0x...00A]' \
                     '[1000e18, 1000e18, ..., 1000e18]'

forge create contracts/DistributionCampaign.sol:DistributionCampaign \
  --rpc-url https://sepolia.base.org \
  --private-key $PRIVATE_KEY \
  --broadcast --root .

# Repeat for Arbitrum Sepolia with --rpc-url https://sepolia-rollup.arbitrum.io/rpc
```

Demo contracts already deployed:

| Contract              | Base Sepolia                                         | Arbitrum Sepolia                                     |
|-----------------------|------------------------------------------------------|------------------------------------------------------|
| MockUSDC              | `0xba71286Ce2792A955C65c09918C08a0cDfF171FE`         | `0x6320a7b21965430d783Eedda5743824f1B5Ce2Ed`         |
| ShareToken            | `0x2d134178F9efC772A93BB83632965E6b731e1E19`         | `0x81051f77ea167b631Dd7F40ac414A9F9344Fb162`         |
| DistributionCampaign  | `0xB7c84e9e20F894e02493e27558d030dD3AEC0576`         | `0x801a153c4811235F10A69836F4eD0EcA76F2E693`         |

### 2. Update addresses

Edit `src/lib/constants.ts` with your deployed addresses, and the `WHERE lower(address) = ...` filter in `pipeline/base-sepolia.yaml` and `pipeline/arb-sepolia.yaml` with each chain's `ShareToken`.

### 3. Deploy compose first (so Neon DB + secret get provisioned)

```bash
goldsky compose deploy
```

Compose-cloud auto-provisions a hosted Neon DB and creates a Goldsky-project secret named `CORPORATE_ACTIONS` referencing it. Watch the cron logs for the line:

```text
Operator wallet: 0x... No active campaigns; idle.
```

That's your operator wallet. Note the address.

### 4. Mint USDC to the operator wallet

```bash
cast send <MOCK_USDC_BASE_SEPOLIA> "mint(address,uint256)" <OPERATOR> 1000000000000 \
  --rpc-url https://sepolia.base.org --private-key $PRIVATE_KEY

cast send <MOCK_USDC_ARB_SEPOLIA> "mint(address,uint256)" <OPERATOR> 1000000000000 \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc --private-key $PRIVATE_KEY
```

### 5. Deploy the Turbo pipelines

```bash
goldsky turbo apply pipeline/base-sepolia.yaml
goldsky turbo apply pipeline/arb-sepolia.yaml
```

Pipelines start backfilling immediately. Within ~60 seconds, `share_balances` should show the 10 pre-minted holders per chain. (Optional but recommended for production: add a partial index `CREATE INDEX share_balances_lookup ON share_balances (token, chain) WHERE balance > 0;`)

### 6. Declare a campaign

```bash
curl -sX POST "https://api.goldsky.com/api/admin/compose/v1/corporate-actions/tasks/declare_campaign" \
  -H "content-type: application/json" \
  -H "Authorization: Bearer $GOLDSKY_TOKEN" \
  -d '{
    "campaignId": "0x000000000000000000000000000000000000000000000000000000000000c0a1",
    "chain": "baseSepolia",
    "shareToken": "0x2d134178F9efC772A93BB83632965E6b731e1E19",
    "totalAmount": "10000000000"
  }'
```

That declares a 10,000 mUSDC dividend on Base Sepolia. Repeat with `chain: "arbitrumSepolia"` and the Arb shareToken to declare on the other chain.

Within 2-3 cron cycles (after finality + 32 blocks), all 10 holders on each chain will have received 1,000 mUSDC each.

### 7. Verify on-chain

```bash
cast call <DISTRIBUTION_CAMPAIGN> "getCampaign(bytes32)" <onChainId> \
  --rpc-url https://sepolia.base.org
```

`escrowRemaining` will be exactly 0 once all 10 holders are paid. The full audit trail is in the contract's `HolderPaid` events.

## Crash-safety walkthrough

The institutional credibility of this demo lives or dies here. The contract is the source of truth for "did this holder get paid?" — compose can crash anytime, restart anytime, and never double-pay or skip a holder.

To verify yourself:

1. POST a fresh campaign (different `campaignId` so it doesn't dedup against an old one).
2. Wait 30-60 seconds. Some holders should be paid; others still pending. Verify by scanning `HolderPaid` events on the chain.
3. Pause the compose app: `goldsky compose pause`.
4. Resume: `goldsky compose resume`.
5. Within the next cron cycle, every remaining holder gets paid. **Zero duplicates** on-chain (verify by counting `HolderPaid` events for the campaign).

What's protecting you:

- **Compose's collection only stores campaign metadata** (status, declareTxHash). It does NOT cache per-holder paid state. There's no off-chain DB to diverge from on-chain truth.
- **Per-holder `isPaid()` check before each `pay()` call** — already-paid holders are skipped without an attempted tx.
- **Contract's `require(!paid[id][holder], "AlreadyPaid")`** — even if a stale tx arrives after restart, the contract rejects it. No double-pay possible regardless of compose's state.

## Customization

### Swap the share token

Replace the `shareToken` address in `CHAIN_CONFIG` and the `WHERE lower(address) = ...` filter in the Turbo pipeline YAMLs. Re-apply pipelines.

### Add or swap chains

Add a `ChainKey` entry to `src/lib/types.ts`, populate `CHAIN_CONFIG`, and create a new `pipeline/<chain>.yaml`. Compose's `evm.chains` exposes most testnets and mainnets via the same idiom.

### Change cadence or finality depth

Edit `compose.yaml` cron expression and `FINALITY_DEPTH` in `constants.ts`. For Ethereum mainnet, use a longer finality depth (~96 blocks) than the L2 default (32).

### Use real USDC

Swap `MockUSDC.sol` for the real USDC address per chain in `CHAIN_CONFIG`. Note: real USDC isn't fee-on-transfer, so the contract's `escrowRemaining` math is exact.

## When NOT to use this pattern

This is **push-based pro-rata** — bounded by the gas-sponsored bundler's throughput (~1-5 userOps/sec per sender). At >100 holders the cron loop overlaps cycles; at >1000 it's the wrong shape entirely. Production-scale distributions (Apple has millions of shareholders) use **merkle-claim contracts** instead — operator publishes one root, holders pull.

This example demonstrates orchestration, idempotency, and audit-trail primitives that apply to either model. The on-chain shape changes; the compose plumbing doesn't.

## Resources

- [Compose introduction](https://docs.goldsky.com/compose/introduction)
- [Turbo postgres_aggregate sink](https://docs.goldsky.com/turbo-pipelines/sinks/postgres-aggregate)
- [CMTAT IncomeVault](https://github.com/CMTA/IncomeVault) — Swiss-bank reference impl for tokenized-equity dividends; our event schema is anchored on this convention
- [ERC-1726 Dividend-Paying Token](https://github.com/Roger-Wu/erc1726-dividend-paying-token)
- [GitHub repository](https://github.com/goldsky-io/documentation-examples/tree/main/compose/corporate-actions)
