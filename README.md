### Goldsky Documentation Examples

This repo contains public examples of Goldsky Mirror Pipelines, Subgraphs, and Compose apps that are referenced across the [Goldsky documentation](https://docs.goldsky.com/).

#### Compose examples — guided setup

The fastest way to build and deploy a Compose example under your own account is the **Goldsky agent plugin**, which is the single source of truth for the setup procedures:

```bash
npx skills add goldsky-io/goldsky-agent
```

Then ask your agent (Claude Code, Cursor, Codex, etc.) to build one, or trigger the skill directly:

| Example (`compose/…`) | Skill |
| --- | --- |
| `bitcoin-oracle` | `/compose-bitcoin-oracle` |

The skill scaffolds the example, recommends a shared no-deploy contract on Base Sepolia, and walks wiring → deploy → smoke test. The example directory here remains the runnable reference implementation; its `AGENTS.md` points back at the skill.
