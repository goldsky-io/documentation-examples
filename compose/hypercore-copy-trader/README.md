# HyperCore Whale Copy-Trader

A [Compose](https://docs.goldsky.com/compose/introduction) + [Turbo](https://docs.goldsky.com/turbo-pipelines/introduction) example that watches whale-sized fills on Hyperliquid's HyperCore (mainnet) and mirrors each one at a tiny fraction on HyperCore **testnet** via [`ctx.hypercore`](https://docs.goldsky.com/compose/context/hypercore).

Any fill with notional >= $10k counts as a whale trade. Each one is mirrored at 0.001x (capped at $25, floored at the ~$10 exchange minimum) as a marketable IOC order. On an average day this delivers dozens of events per minute, so it doubles as a live-fire test of the whole hypercore dataset -> Compose path.

## How It Works

```
Hyperliquid HyperCore (mainnet)
       │  every fill
       ▼
  ┌──────────────────────┐
  │  Turbo Pipeline      │  hypercore.fills dataset, start_at: latest
  │  (hypercore-whale-   │  SQL filter: price * size >= $10k
  │   fills)             │  → webhook, one fill per POST
  └──────────┬───────────┘
             │
             ▼
  ┌──────────────────────┐
  │  Compose App         │
  ├──────────────────────┤
  │  copy_trade (http)   │  dedupe by fill id → size at 0.001x →
  │                      │  ctx.hypercore.trade.order (testnet, IOC)
  │  status (http)       │  wallet, balances, positions, mirror count
  └──────────────────────┘
```

The pipeline + webhook + task chain is exactly the machinery Compose's `onchain_event` trigger generates internally for EVM chains — hand-rolled here because HyperCore fills are dataset rows, not contract logs. The task:

1. Validates the fill row (untrusted input) and dedupes by fill id in a collection — webhook delivery is at-least-once.
2. Skips coins outside `COIN_ALLOWLIST` and fills below `MIN_FILL_NOTIONAL`.
3. Resolves the asset index and `szDecimals` from `meta` (cached in a collection), sizes the order against the **testnet** mid, and places an IOC limit that crosses the spread.
4. Tops the perp account up from spot USDC (`usdClassTransfer`) when margin runs below $20.
5. Logs `MIRROR_EXECUTED` / `MIRROR_SKIPPED` / `MIRROR_FAILED` and always returns normally, so a bad fill never stalls the pipeline.

Mainnet fills drive testnet orders on purpose: the signal is real, the money is not.

## Quick Start

### 1. Fund a testnet account

Any Ethereum keypair is a HyperCore account. Claim testnet USDC with the faucet at [app.hyperliquid-testnet.xyz](https://app.hyperliquid-testnet.xyz), then set the key:

```bash
goldsky compose secret set COPY_TRADER_PRIVATE_KEY --value "0x..."
```

### 2. Deploy the Compose app

```bash
goldsky compose deploy
```

### 3. Point the pipeline at your app and deploy it

Edit `pipeline/hypercore-whale-fills.yaml` and replace `<your-project-id>` in the webhook URL with your Goldsky project id, then:

```bash
goldsky turbo apply pipeline/hypercore-whale-fills.yaml
```

> The `hypercore.fills` dataset is access-gated — contact [support@goldsky.com](mailto:support@goldsky.com) if the pipeline can't resolve it.

### 4. Watch it trade

```bash
curl -X POST https://api.goldsky.com/api/public/compose/v1/<your-project-id>/hypercore-copy-trader/tasks/status \
  -H 'Content-Type: application/json' -d '{}'
```

`mirroredFillCount` climbs with every mirrored whale fill; `positions` shows the net testnet book. Or tail the logs:

```bash
goldsky compose logs -f
```

### Shutting it down

Delete the pipeline first (it is the trade source), then pause the app:

```bash
goldsky turbo delete hypercore-whale-fills
goldsky compose pause
```

## Configuration

All knobs live in `compose.yaml` under `env`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `HYPERCORE_NETWORK` | `testnet` | Where mirror orders execute. Setting `mainnet` trades real money. |
| `MIRROR_RATIO` | `0.001` | Fraction of the whale's fill size to mirror. |
| `MIN_FILL_NOTIONAL` | `10000` | Ignore fills below this USD notional (also enforced in the pipeline SQL — keep them in sync). |
| `MAX_ORDER_NOTIONAL` | `25` | Hard cap per mirror order, USD. |
| `COIN_ALLOWLIST` | `BTC,ETH,SOL,HYPE` | Perps the bot may trade. |

To copy specific wallets instead of a size threshold, add `AND user IN ('0x...', '0x...')` to the pipeline's SQL transform.

## Gotchas

- **The exchange minimum order is ~10 USDC notional** — the task floors orders at $10.5, so at `MIRROR_RATIO: 0.001` every whale fill >= $10k mirrors at roughly the minimum.
- **Mainnet and testnet are separate exchanges** with separate accounts, prices, and asset universes. The task sizes and prices orders against the *target* network's `meta` and mids, never the whale's fill price.
- **Rate limits**: Hyperliquid allows roughly one action per 1 USDC of cumulative traded volume after an initial allowance. A high-frequency mirror at minimum size eventually gets throttled — raise `MIN_FILL_NOTIONAL` to slow it down.
- **Closes are mirrored as plain opposite-side orders** (never `reduceOnly`), so the bot's book is a scaled echo of whale *flow*, not whale *positions*.
