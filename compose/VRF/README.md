# Compose VRF

A [Compose](https://docs.goldsky.com/compose/introduction) demo app that fulfills on-chain randomness requests using [drand](https://drand.love) — a distributed randomness beacon.

## How It Works

```
┌─────────────┐     emit event      ┌─────────────┐
│   Source    │ ──────────────────► │   Compose   │
│  Contract   │                     │    Task     │
└─────────────┘                     └──────┬──────┘
                                           │
                                           │ fetch randomness
                                           ▼
                                    ┌─────────────┐
                                    │    drand    │
                                    │     API     │
                                    └──────┬──────┘
                                           │
                                           │ {round, randomness, signature}
                                           ▼
┌─────────────┐   fulfillRandomness ┌─────────────┐
│   Target    │ ◄────────────────── │   Compose   │
│  Contract   │                     │    Task     │
└─────────────┘                     └─────────────┘
```

1. **Source contract** emits a `RandomnessRequested` event
2. **Compose task** is triggered by the on-chain event
3. **drand API** is called to fetch verifiable randomness
4. **Target contract** receives the randomness with full proof data

Source and target can be the same contract or different contracts.

## Quick Start

### 1. Get your Compose wallet address

Terminal 1:
```bash
goldsky compose start
```

Terminal 2:
```bash
goldsky compose callTask generate_wallet '{}'
```

Save the wallet address — this will be the authorized fulfiller.

### 2. Deploy your own contract (optional)

A demo contract is already deployed on Base Sepolia at `0xE05Ceb3E269029E3bab46E35515e8987060D1027`. To deploy your own:

```bash
# Install Foundry if needed: https://book.getfoundry.sh/getting-started/installation

forge create contracts/RandomnessConsumer.sol:RandomnessConsumer \
  --rpc-url https://sepolia.base.org \
  --private-key $PRIVATE_KEY \
  --constructor-args 0xYOUR_COMPOSE_WALLET_ADDRESS \
  --broadcast
```

Then update the contract address in three places:
- `compose.yaml` — the `contract` field under `onchain_event` trigger
- `src/tasks/fulfill-randomness.ts` — `TARGET_CONTRACT`
- `src/tasks/request-randomness.ts` — `CONTRACT_ADDRESS`

### 3. Run locally

```bash
goldsky compose start
```

### 4. Test it

Request randomness via the HTTP task:
```bash
goldsky compose callTask request_randomness '{}'
```

Or call the contract directly:
```bash
cast send 0xE05Ceb3E269029E3bab46E35515e8987060D1027 "requestRandomness()" \
  --rpc-url https://sepolia.base.org \
  --private-key $PRIVATE_KEY
```

Watch the Compose logs — it should pick up the event and fulfill the request.

### 5. Deploy to Goldsky

```bash
goldsky compose deploy
```

## Project Structure

```
vrf/
├── compose.yaml                    # Compose configuration
├── contracts/
│   └── RandomnessConsumer.sol      # Example contract
├── src/
│   ├── contracts/
│   │   └── RandomnessConsumer.json # Contract ABI (for codegen)
│   ├── lib/
│   │   └── drand.ts                # drand API utilities
│   └── tasks/
│       ├── fulfill-randomness.ts   # Fulfills randomness on-chain (event trigger)
│       ├── generate-wallet.ts      # Outputs Compose wallet address (HTTP trigger)
│       └── request-randomness.ts   # Requests randomness on-chain (HTTP trigger)
└── README.md
```

## Resources

- [drand Documentation](https://docs.drand.love)
- [Compose Documentation](https://docs.goldsky.com/compose/introduction)
