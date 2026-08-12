# Compose HyperCore Vault

A [Compose](https://docs.goldsky.com/compose/introduction) example that runs a **Hyperliquid vault without a Hyperliquid vault** — no legacy HyperCore vault, no HyperEVM contract. Funds sit in an ordinary HyperCore account and a Compose app does everything a vault does: attributes deposits, prices shares against NAV, runs the strategy, and remits on validated off-chain conditions.

## Why this exists

Hyperliquid's native HyperCore vaults are now labelled **legacy** in the docs: they were introduced in 2023 and *do not support HIP-3 or spot trading*. The [officially recommended replacement](https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/vaults) is to build an ERC-4626 vault on **HyperEVM** that reaches HyperCore through the `CoreWriter` system contract.

That path has real costs for a trading vault:

- `CoreWriter` is **fire-and-forget**: it emits a log and returns nothing, so the contract cannot see whether an order succeeded and must poll HyperCore state through precompiles afterwards.
- Order actions submitted from HyperEVM are **deliberately delayed a few seconds** so EVM users get no latency edge over the Core mempool.
- Every action costs gas (~47k) and the action vocabulary is a fixed table.

This example takes the third path: keep the capital in a plain HyperCore account with full-speed native API access (HIP-3 and spot included), and put the programmable layer in Compose — durable collections as the share ledger, escrow-style custody, conditional remittance.

**Trade-off, stated plainly:** an on-chain ERC-4626 vault gives depositors trustless, independently verifiable accounting. This design gives them an operator-run ledger. It suits funds whose depositors already trust the manager, and it is the wrong choice if trustlessness is the product.

## How It Works

```
     deposit (USDC spot transfer)
 depositor ───────────────────────────────►┌──────────────────────┐
     ▲                                     │   HyperCore account  │
     │                                     │   (holds the funds)  │
     │  payout (spotSend)                  └──────────┬───────────┘
     │                                                │ native API
     │                                     ┌──────────┴───────────┐
     └─────────────────────────────────────│     Compose app      │
                                           │                      │
   cron  ──► index_deposits ──────────────►│  collections:        │
   cron  ──► strategy       ──────────────►│   vault / positions  │
   http  ──► redeem         ──────────────►│   deposits / fills   │
   http  ──► vault_state    ──────────────►│   nav_snapshots      │
   http  ──► create_vault   ──────────────►└──────────────────────┘
```

1. **`index_deposits`** (cron) reads `userNonFundingLedgerUpdates`, finds inbound USDC transfers to the vault account, and mints shares priced against NAV *before* the deposit landed. Deduped by transfer hash.
2. **`strategy`** (cron) moves a slice of NAV into the perps balance and runs a long/flat rotation on a HyperCore perp with marketable IOC orders, then records fills and a NAV snapshot. This is what makes the share price move.
3. **`redeem`** (HTTP) validates the off-chain conditions — lockup elapsed, size threshold, operator approval, solvency — then remits the NAV-priced payout with a user-signed `spotSend`.
4. **`vault_state`** (HTTP) is the read model: NAV, share price, positions, snapshots, strategy state, fills.
5. **`create_vault`** (HTTP) initializes a vault: captures the non-vault baseline and clears the ledger.

## Share math

Share price is `NAV / total shares`. NAV is the vault account's **value minus a baseline** captured at initialization, so operator float that happens to share the account is never counted as depositor capital:

```
NAV = (spot USDC + perps account value) - baselineUsdc
```

| Event | NAV | Shares | Price | Depositor claim |
| --- | --- | --- | --- | --- |
| Vault initialized | 0 | 0 | 1.00 | — |
| Alice deposits 25 | 25 | 25 | 1.00 | 25.00 |
| Strategy gains 5 | 30 | 25 | 1.20 | 30.00 |
| Bob deposits 30 | 60 | 50 | 1.20 | Alice 30.00, Bob 30.00 |
| Alice redeems all | 30 | 25 | 1.20 | Bob 30.00 |

Deposits never move the price (you buy at the current price); strategy P&L does.

## Compose Features Demonstrated

- `ctx.hypercore.info.*` — typed HyperCore reads (`allMids`, `clearinghouseState`, `spotClearinghouseState`) plus generic `info` for ledger updates and fills
- `ctx.hypercore.trade.order` — marketable IOC orders on a perp (L1 signing scheme)
- `ctx.hypercore.transfer.usdClassTransfer` / `spotSend` — moving margin and paying depositors (user-signed EIP-712 scheme)
- `ctx.collection` — durable ledger: vault record, positions, deposits, fills, NAV snapshots, cursors
- Cron and HTTP triggers in one app; `ctx.logEvent` for an auditable deposit/redemption trail

## Configuration

| Env | Meaning |
| --- | --- |
| `HYPERCORE_NETWORK` | `testnet` or `mainnet` |
| `MIN_DEPOSIT` | Smallest accepted deposit, in USDC |
| `LOCKUP_SECONDS` | How long after a deposit before shares can be redeemed |
| `LARGE_REDEMPTION_USDC` | Redemptions above this need the operator flag |
| `OPERATOR_APPROVES_LARGE_REDEMPTIONS` | Operator gate for large redemptions |
| `TRADE_ENABLED` | Whether the strategy leg trades |
| `STRATEGY_COIN` | Perp the strategy trades (e.g. `BTC`) |
| `STRATEGY_ALLOCATION` | Fraction of NAV allocated as margin |
| `STRATEGY_HOLD_SECONDS` | How long a position is held before closing |

Secret: `VAULT_PRIVATE_KEY` — the key for the HyperCore account holding vault funds.

## Running it

```bash
goldsky compose secret set VAULT_PRIVATE_KEY --value 0x... --env local
goldsky compose start

curl -X POST localhost:8000/tasks/create_vault -d '{"name":"My Vault"}'
# send USDC from another wallet to the vault address, then:
curl -X POST localhost:8000/tasks/index_deposits -d '{}'
curl -X POST localhost:8000/tasks/strategy       -d '{}'
curl -X POST localhost:8000/tasks/vault_state    -d '{}'
curl -X POST localhost:8000/tasks/redeem         -d '{"depositor":"0x..."}'
```

> **Requires** a Compose runtime with `ctx.hypercore` support. Initialize the vault *after* the account holds only the float you want excluded from NAV — the baseline is captured at that moment, and depositor capital must arrive afterwards.

## Operational notes

- **Testnet first.** Every default here points at Hyperliquid testnet.
- **A wallet reference is full authority.** Anything holding the vault key can move the funds; this design's security boundary is the Compose app and its secret, not a contract.
- **Payouts leave from the spot balance.** Capital parked as perps margin must be unwound by the strategy before a large redemption can be paid, which the redeem task enforces rather than silently under-paying.
