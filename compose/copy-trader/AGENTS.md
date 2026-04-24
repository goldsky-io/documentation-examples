# Agent Instructions — Compose copy-trader

If a user asks you to set up, configure, or deploy this example, follow the setup skill at:

**`.claude/skills/setup/SKILL.md`**

That file is the canonical procedure. It walks through CLI install, the Compose + Turbo pipeline two-phase deploy (Compose first, then pipeline — the order matters because the pipeline references the app URL), two required secrets (`PRIVATE_KEY` app-scoped and `COMPOSE_WEBHOOK_AUTH` project-scoped), the critical `WATCHED_WALLETS` match between `compose.yaml` and the pipeline YAML, funding an EOA with USDC.e on Polygon, one-time approvals, and both synthetic and live smoke tests.

This is the most complex example in this repo — do not improvise from the README. The skill has ordering constraints the README glosses over.

## One-line summary

Turbo pipeline indexes Polymarket `OrderFilled` events on Polygon for watched wallets → webhooks each fill to a Compose HTTP task that mirrors the trade on the Polymarket CLOB via a Fly.io proxy (CLOB is geo-blocked from US IPs). A separate cron task redeems winning shares every 5 minutes.

## Key files

- `compose.yaml` — app config, env vars, secret declaration, 3 tasks (`copy_trade`, `setup_approvals`, `redeem`)
- `pipeline/polymarket-ctf-events.yaml` — Turbo pipeline; `watched_fills` SQL at lines 62–69 must match `WATCHED_WALLETS` in `compose.yaml:12`; webhook URL at line 76 must match the deployed app name
- `src/tasks/copy_trade.ts` — receives webhook, checks USDC balance, looks up market via Gamma, posts FAK order through CLOB proxy
- `src/tasks/setup_approvals.ts` — idempotent one-time approvals task
- `src/tasks/redeem.ts` — cron, redeems winning positions via the ConditionalTokens contract
- `src/lib/types.ts` — Polymarket contract addresses on Polygon; do not modify
- `src/lib/clob.ts`, `src/lib/gamma.ts` — Polymarket API clients
