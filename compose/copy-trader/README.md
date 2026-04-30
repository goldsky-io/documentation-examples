# Copy Trader

A [Compose](https://docs.goldsky.com/compose/introduction) + [Turbo](https://docs.goldsky.com/turbo/introduction) example that mirrors Polymarket trades from any set of wallets you choose. When a watched wallet buys or sells, the bot places the same side on the CLOB with a $1 notional.

Updated for [Polymarket V2](https://docs.polymarket.com/v2-migration) (cutover 2026-04-28): new V2 Exchange contracts, pUSD collateral, `@polymarket/clob-client-v2`.

## How It Works

```
Polygon on-chain
       │
       └─ V2 CTF Exchange + V2 NegRisk Exchange: OrderFilled events
            │
            ▼
  ┌──────────────────────┐
  │  Turbo Pipeline      │  decode V2 fills, filter to watched wallets
  │  (polymarket-ctf-    │  → webhook per fill
  │   events)            │
  └──────────┬───────────┘
             │
             ▼
  ┌──────────────────────┐
  │  Compose App         │
  ├──────────────────────┤
  │  copy_trade (http)   │  sign + POST V2 order to Polymarket CLOB
  │  redeem (cron 5m)    │  redeem winning shares on-chain
  │  setup_approvals     │  one-time approvals + USDC.e → pUSD wrap
  └──────────────────────┘
```

Fills are indexed by Turbo, webhooked to Compose, signed with an EOA key, and submitted to the CLOB through a Fly.io proxy (Polymarket's CLOB API is geo-blocked from US Compose hosts). Winning shares auto-redeem every 5 minutes.

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Pick wallets to copy and update both configs

Edit `compose.yaml`:

```yaml
env:
  cloud:
    WATCHED_WALLETS: "0xwhale1,0xwhale2"
```

Edit `pipeline/polymarket-ctf-events.yaml` to match — the same addresses go in the `watched_fills` transform. The pipeline pre-filters on-chain, so the two lists must agree.

### 3. Set your wallet's private key

The Compose app signs CLOB orders as an EOA (no Polymarket proxy wallet needed):

```bash
goldsky compose secret set PRIVATE_KEY --value "0x..."
```

### 4. Create the webhook auth secret (one time per project)

The Turbo webhook authenticates to your Compose app with this secret:

```bash
goldsky secret create --name COMPOSE_WEBHOOK_AUTH \
  --value '{"type": "httpauth", "secretKey": "Authorization", "secretValue": "Bearer YOUR_COMPOSE_API_TOKEN"}'
```

### 5. Deploy the app and pipeline

```bash
goldsky compose deploy
goldsky turbo apply pipeline/polymarket-ctf-events.yaml
```

### 6. Fund the wallet

Send USDC.e (`0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`) on Polygon to your EOA. Compose sponsors gas, so no MATIC is required. `setup_approvals` will wrap the USDC.e into pUSD before trading.

### 7. Grant approvals + wrap collateral

One-time setup that approves the Collateral Onramp and both V2 Exchanges, then wraps your USDC.e balance into pUSD. Triggers a handful of sponsored on-chain transactions:

```bash
curl -X POST -H "Authorization: Bearer $COMPOSE_TOKEN" \
  https://api.goldsky.com/api/admin/compose/v1/copy-trader/tasks/setup_approvals
```

The bot starts trading as soon as a watched wallet's next fill hits the pipeline.

To top up later: send more USDC.e to the EOA, then call `setup_approvals` again. It's idempotent — re-runs just re-emit the (already-set) approvals and wrap whatever USDC.e the wallet currently holds.

## Project Structure

```
copy-trader/
├── compose.yaml                           # Compose app + env config
├── tsconfig.json                          # Compose type paths
├── package.json                           # npm deps (bundled by Compose CLI)
├── pipeline/
│   └── polymarket-ctf-events.yaml         # Turbo pipeline → webhook sink
└── src/
    ├── lib/
    │   ├── clob.ts                        # V2 CLOB client (ctx.fetch based)
    │   ├── gamma.ts                       # Market metadata lookups
    │   └── types.ts                       # Contract addresses + shared types
    └── tasks/
        ├── copy_trade.ts                  # HTTP: receive fill → mirror trade
        ├── redeem.ts                      # Cron: redeem winning shares
        └── setup_approvals.ts             # HTTP: approvals + USDC.e → pUSD wrap
```

## Compose Features Demonstrated

- **Turbo → Compose webhook** — a Turbo pipeline sinks decoded events to a Compose HTTP task
- **Cron triggers** — `redeem` runs every 5 minutes
- **`ctx.fetch`** — all outbound HTTP (Polymarket CLOB + Gamma + data API) goes through Compose's host-mediated fetch
- **`ctx.evm.wallet` with sponsored gas** — on-chain calls (approvals, wrap, redemptions) use a Compose-sponsored wallet
- **`ctx.collection`** — `positions` and `trades` collections for persistent state
- **Secrets** — wallet private key stored via `goldsky compose secret set`

## Customization

### Trade size

Default is Polymarket's $1 minimum notional. Raise it in `compose.yaml`:

```yaml
TRADE_AMOUNT_USD: "10"
```

### Use your own proxy

`CLOB_HOST` defaults to a shared Goldsky-hosted Fly proxy. To isolate from it, deploy your own (see [`fly-polymarket-proxy`](https://github.com/goldsky-io/fly-polymarket-proxy)) and update `CLOB_HOST`.

## Notes

- The bot signs directly as the EOA. No Polymarket proxy wallet, no UI onboarding needed — just fund the EOA address with USDC.e.
- `copy_trade` reads on-chain pUSD balance before every BUY and skips if it would breach the $1.10 minimum. Local balance tracking isn't used — the chain is the source of truth.
- `setup_approvals` is idempotent. Re-run it after every USDC.e top-up to wrap fresh collateral; the approvals are max-allowance so re-approving is a cheap no-op.
- `redeem` only handles standard (non-NegRisk) markets. NegRisk redemption goes through the NegRiskAdapter contract — out of scope for this example.

## V2 contracts on Polygon

| Contract | Address |
|----------|---------|
| CTF Exchange V2 | `0xE111180000d2663C0091e4f400237545B87B996B` |
| NegRisk Exchange V2 | `0xe2222d279d744050d28e00520010520000310F59` |
| Conditional Tokens (unchanged) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| Collateral Onramp | `0x93070a847efEf7F70739046A929D47a521F5B8ee` |
| pUSD | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` |
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |

## Resources

- [Compose Documentation](https://docs.goldsky.com/compose/introduction)
- [Turbo Documentation](https://docs.goldsky.com/turbo/introduction)
- [Polymarket V2 migration](https://docs.polymarket.com/v2-migration)
- [Polymarket CLOB API](https://docs.polymarket.com/)
