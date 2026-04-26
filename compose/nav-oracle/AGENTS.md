# Agent Instructions — Compose nav-oracle

If a user asks you to set up, configure, or deploy this example, follow the setup skill at:

**`.claude/skills/compose-nav-oracle-setup/SKILL.md`**

That file is the canonical procedure. It walks the user through CLI install, a two-phase deploy (first deploy Compose to provision the publisher wallet address, then `forge create` the `ReserveAggregator` on each chain, then wire the addresses back into the task and redeploy), optional custodian URL swap, optional GitHub publishing, and the final log-tailing smoke test.

The README is human-facing and skips preflight checks that matter for a first-time user. Prefer the skill.

## One-line summary

Cron-driven on-chain NAV / Proof-of-Reserves publisher. Fetches a custodian JSON bundle, scales to 18-decimal fixed-point, writes to `ReserveAggregator` contracts on Base Sepolia + Arbitrum Sepolia in parallel. Gas is sponsored by Goldsky.

## Key files

- `compose.yaml` — cron schedule (default `*/5 * * * *`) and retry config
- `contracts/ReserveAggregator.sol` — AggregatorV3Interface-compatible publisher; user deploys one per chain
- `src/tasks/nav-oracle.ts` — the cron task; contains aggregator addresses (lines 22–23) and custodian URL (lines 12–13), both of which the user edits
- `src/lib/scaling.ts` — USD → 18-decimal fixed-point; do not modify, coupled to the contract
- `mock-custodian.json` — sample custodian response; user swaps `CUSTODIAN_URL` to their own endpoint serving the same JSON shape
