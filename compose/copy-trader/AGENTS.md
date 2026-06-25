# Agent Instructions — Compose copy-trader

The canonical, up-to-date setup procedure for this example lives in the **Goldsky agent plugin**, not in this repo. Install it and run the skill:

```bash
npx skills add goldsky-io/goldsky-agent
```

Then trigger **`/compose-copy-trader`** (or just ask your agent to "build a Polymarket copy-trader"). That skill is the single source of truth: it scaffolds from the canonical `goldsky-io/copy-trader` repo and walks the two-phase Compose-then-pipeline deploy, the two required secrets (`PRIVATE_KEY` app-scoped, `COMPOSE_WEBHOOK_AUTH` project-scoped), the `WATCHED_WALLETS` match, funding USDC.e on Polygon, one-time approvals, and synthetic + live smoke tests.

This is the most complex example and trades real money on Polygon mainnet — do not improvise from this README. The skill has ordering constraints and security caveats the README glosses over.

## One-line summary

Turbo pipeline indexes Polymarket `OrderFilled` events on Polygon for watched wallets → webhooks each fill to a Compose HTTP task that mirrors the trade on the Polymarket CLOB via an EU proxy (CLOB is geo-blocked from US IPs). A cron task redeems winning shares.

## Key files

- `compose.yaml` — app config, env vars, secret declaration, tasks (`copy_trade`, `setup_approvals`, `redeem`, `status`, …)
- `pipeline/polymarket-ctf-events.yaml` — Turbo pipeline; the `watched_fills` SQL must match `WATCHED_WALLETS` in `compose.yaml`; the webhook URL must match the deployed app name
- `src/tasks/copy_trade.ts` — receives webhook, checks USDC balance, looks up market via Gamma, posts an order through the CLOB proxy
- `src/lib/types.ts` — Polymarket contract addresses on Polygon; do not modify
- `src/lib/clob.ts`, `src/lib/gamma.ts` — Polymarket API clients (routed through `ctx.fetch`)
