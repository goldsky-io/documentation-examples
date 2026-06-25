# Agent Instructions — Compose VRF

The canonical, up-to-date setup procedure for this example lives in the **Goldsky agent plugin**, not in this repo. Install it and run the skill:

```bash
npx skills add goldsky-io/goldsky-agent
```

Then trigger **`/compose-vrf`** (or just ask your agent to "build a VRF"). That skill is the single source of truth: it scaffolds this example, recommends the shared fully-unpermissioned `RandomnessConsumer` on Base Sepolia (nothing to deploy), and walks contract choice, wiring the address into the three files that reference it, deploy, and an event-trigger smoke test. Do not improvise a setup procedure from this README.

## One-line summary

Event-triggered Compose app that fulfills on-chain `RandomnessRequested` events using drand verifiable randomness. Base Sepolia by default; any EVM chain supported by Compose's `onchain_event` trigger works.

## Key files

- `compose.yaml` — trigger config (chain, contract address, event signature)
- `contracts/RandomnessConsumer.sol` — Solidity contract for the deploy-your-own path
- `src/tasks/fulfill-randomness.ts` — event handler that writes randomness on-chain
- `src/tasks/request-randomness.ts` — HTTP task that emits a request event (useful for testing without MetaMask)
- `src/tasks/generate-wallet.ts` — HTTP task that returns the Compose wallet address
- `src/lib/drand.ts` — drand client; do not modify unless intentionally switching drand networks
