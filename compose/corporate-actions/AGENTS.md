# Agent Instructions — Compose corporate-actions (dividend distribution)

The canonical, up-to-date setup procedure for this example lives in the **Goldsky agent plugin**, not in this repo. Install it and run the skill:

```bash
npx skills add goldsky-io/goldsky-agent
```

Then trigger **`/compose-dividend-distribution`** (or just ask your agent to "build a dividend distribution"). That skill is the single source of truth: it scaffolds this example, recommends the shared fully-unpermissioned contracts on Base Sepolia (nothing to deploy), wires the project key + auto-provisioned Neon DB, helps build a cap table, and walks the declare → snapshot → pay smoke test. Do not improvise a setup procedure from this README.

## One-line summary

Pays N share-token holders pro-rata for a tokenized corporate action (dividend, coupon, rebate, airdrop) idempotently and durably in a single HTTP request: a `declare_campaign` task snapshots holders at an operator-supplied record block via a one-shot job-mode Turbo pipeline, pays each holder with gas-sponsored writes, and leaves a tamper-evident on-chain audit trail. Compose orchestrates Turbo as an ephemeral subroutine — no always-on indexing.

## Key files

- `compose.yaml` — one HTTP task (`declare_campaign`); declares the `GOLDSKY_PROJECT_KEY` secret
- `src/tasks/declare-campaign.ts` — drives the full declare → snapshot → pay → cleanup lifecycle inline; idempotent on `campaignId`
- `src/lib/turbo.ts` — `/api/v1/pipelines` client + the snapshot-pipeline builder
- `src/lib/driver.ts` — state-machine driver (snapshot → paying → complete)
- `contracts/` — `DistributionCampaign.sol` (escrow + `AlreadyPaid` guard + audit events), `MockUSDC.sol`, `OpenShareToken.sol`, `ShareToken.sol`
- `src/lib/constants.ts` — contract addresses + `shareTokenDeployBlock` (the snapshot lower bound)
