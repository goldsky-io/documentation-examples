# Agent Instructions — Compose solana-transactions

If a user asks you to set up, configure, or deploy this example, follow the setup skill at:

**`.claude/skills/setup/SKILL.md`**

That file is the canonical procedure. It covers CLI install (goldsky, solana, node), keypair generation and funding, creating the two required Compose secrets (`SOLANA_RPC_URL`, `SOLANA_KEYPAIR`), the choice of targeting the shared demo Anchor program on devnet vs the user's own program (with discriminator + PDA seed edits), optional GitHub publishing, and a smoke test that returns a real on-chain Solana transaction signature.

The README is human-facing and skips preflight checks that matter for a first-time user.

## One-line summary

HTTP-triggered Compose task that builds, signs, and sends a Solana transaction to an Anchor program via a PDA, using Gill through Compose's sandboxed fetch. Default target is a demo program on devnet; any Anchor program on any Solana cluster works with three edits (program ID, discriminator, PDA seeds).

## Key files

- `compose.yaml` — declares two secrets (`SOLANA_RPC_URL`, `SOLANA_KEYPAIR`) and one HTTP task
- `src/tasks/solana-writer.ts` — the task; `PROGRAM_ID` (line 16), `WRITE_DISCRIMINATOR` (line 21), PDA seeds (line 94), and instruction data layout (lines 98–111) are what the user edits to target a different program
- `package.json` — Gill dependency; run `npm install` before anything else
