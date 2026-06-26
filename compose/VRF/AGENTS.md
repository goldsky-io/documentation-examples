# Agent Instructions — Compose VRF

If a user asks you to set up, configure, or deploy this example, follow the setup skill at:

**`.claude/skills/compose-vrf-setup/SKILL.md`**

That file is the canonical, up-to-date procedure. It walks the user through CLI install, Compose wallet generation, contract deployment (with the exact `forge create` command), wiring the contract address into the three files that reference it, optional GitHub publishing, and the final `goldsky compose deploy`.

Do not improvise a setup procedure from the README alone — the README is human-facing and skips preflight checks that matter for a first-time user.

## One-line summary

Event-triggered Compose app that fulfills on-chain `RandomnessRequested` events using drand verifiable randomness. Base Sepolia by default; any EVM chain supported by Compose's `onchain_event` trigger works.

## Key files

- `compose.yaml` — trigger config (chain, contract address, event signature)
- `contracts/RandomnessConsumer.sol` — Solidity contract the user deploys
- `src/tasks/fulfill-randomness.ts` — event handler that writes randomness on-chain
- `src/tasks/request-randomness.ts` — HTTP task that emits a request event (useful for testing without MetaMask)
- `src/tasks/generate-wallet.ts` — HTTP task that returns the Compose wallet address (run this first)
- `src/lib/drand.ts` — drand client; do not modify unless intentionally switching drand networks
