# Compose HIP-4 Outcome Oracle

A [Compose](https://docs.goldsky.com/compose/introduction) example that operates **Hyperliquid HIP-4 outcome markets** end to end: it deploys recurring short-dated crypto price markets and settles each one at expiry. Roughly 150 lines of TypeScript doing the job a prediction-market operator would otherwise staff.

## What HIP-4 is

HIP-4 added **outcome markets** to HyperCore: fully collateralized binary contracts that settle to $0 or $1, sharing the same order book, margining, and account model as perps and spot. Permissionless deployment is template-based — validators approve *templates*, and a staked deployer instantiates them by filling in keywords. Deploying and settling are HyperCore L1 actions signed by the deployer's authorized oracle updater.

The market this example runs is the Polymarket-style **up/down**: it instantiates the `binaryPrice2` template with the strike set to the perp's mark price at creation, so "Yes" means *the price went up over the window*.

## How It Works

```
  cron (*/15) ──► create-markets ──► ctx.hypercore.outcome.deploy
                       │                    (binaryPrice2: perp, threshold, time)
                       │                                │
                       │                                ▼
                       │                     ┌───────────────────────┐
                       └────────────────────►│  markets collection   │
                                             │  (outcome index,      │
                                             │   canonical metadata, │
                                             │   expiry, settled)    │
                                             └───────────┬───────────┘
                                                         │
  cron (* * * * *) ──► settle-markets ◄──────────────────┘
                            │
                            ├─ reads the perp mark price at expiry
                            └─ ctx.hypercore.outcome.settle (YES = 1, NO = 0)
```

1. **`create-markets`** reads each configured perp's mark price, deploys a `binaryPrice2` outcome with that mark as the strike, resolves the assigned outcome index from `outcomeMeta`, and records the market with its canonical metadata.
2. **`settle-markets`** scans for expired unsettled markets, reads the mark price, and settles each one — YES if the mark is above the strike, NO otherwise.

Settlement must echo the outcome's canonical `nameAndDescription` and `sideNames` **exactly** as `outcomeMeta` reports them, which is why the create task stores them rather than reconstructing them later.

## Compose Features Demonstrated

- `ctx.hypercore.outcome.deploy` / `outcome.settle` — HIP-4 deployer actions
- `ctx.hypercore.info.allMids` / `info.outcomeMeta` — typed HyperCore reads
- `ctx.collection` — the market registry that makes settlement idempotent and crash-safe
- Cron triggers for a create/settle lifecycle that runs unattended

## Configuration

| Env | Meaning |
| --- | --- |
| `HYPERCORE_NETWORK` | `testnet` or `mainnet` |
| `VENUE` | Your outcome-deployer venue name (2-4 lowercase letters) |
| `PERPS` | Comma-separated perps to run markets for, e.g. `BTC,ETH` |
| `MARKET_DURATION_MINUTES` | Window length; 5-15 for demos, longer for real markets |

Secret: `DEPLOYER_PRIVATE_KEY` — the key for the account registered as the outcome deployer.

## Prerequisites

Deploying outcomes requires being an **activated outcome deployer**, which means meeting Hyperliquid's staking requirement and claiming a venue name:

```ts
await ctx.hypercore.outcome.activateDeployer("testnet", wallet, { venueName: "abcd" });
```

On testnet the requirement is small (peer deployers hold ~100 HYPE staked); on mainnet it is orders of magnitude larger. Testnet also caps active outcomes and deploys per day per deployer, so a tight cron will eventually be refused with `too many outcomes deployed today for deployer` — that is a quota, not a bug.

## Running it

```bash
goldsky compose secret set DEPLOYER_PRIVATE_KEY --value 0x... --env local
goldsky compose start

curl -X POST localhost:8000/tasks/create_markets -d '{}'   # if you add an http trigger
```

> **Requires** a Compose runtime with `ctx.hypercore` support.

## Notes from running this live

- **Side index 0 is YES.** The outcome token coin encoding is `#{10 * outcome + side}`, and side `0` maps to `sideSpecs[0]`, which is the Yes side. Community guides that document side 1 as YES are wrong; verified with a funded trade on testnet.
- **The template fixes the resolution criterion.** `binaryPrice2` settles on the *perp mark price at settlement time*, so the settle task must read that, not an external feed — using a different source would be incorrect and slashable.
- **Templates are the market universe.** You can only deploy shapes validators have approved (`outcomeTemplates` lists them: crypto price targets, policy-rate decisions, sports results at the time of writing). Arbitrary event markets are not permissionless.
