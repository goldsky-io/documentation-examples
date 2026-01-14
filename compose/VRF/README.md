# Compose VRF

A [Compose](https://docs.goldsky.com/compose/introduction) template for fulfilling on-chain randomness requests using [drand](https://drand.love) - a distributed randomness beacon.

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

1. **Source contract** emits an event (e.g., `RandomnessRequested`)
2. **Compose task** is triggered by the event
3. **drand API** is called to fetch verifiable randomness
4. **Target contract** receives the randomness with full proof data

Source and target can be the same contract or different contracts.

## Quick Start

### 1. Deploy the Contract with Forge

First, get your Compose wallet address (this will be the authorized fulfiller):

Terminal 1:
```bash
goldsky compose start
```

Terminal 2:
```bash
goldsky compose callTask generate_wallet '{}'
```

This outputs your wallet address - save it for the next step.

Deploy `RandomnessConsumer.sol` to MegaETH Testnet v2:
```bash
# Install Foundry if needed: https://book.getfoundry.sh/getting-started/installation

# Deploy (replace with your fulfiller wallet address)
forge create contracts/RandomnessConsumer.sol:RandomnessConsumer \
  --rpc-url https://timothy.megaeth.com/rpc \
  --private-key $PRIVATE_KEY \
  --constructor-args 0xYOUR_COMPOSE_WALLET_ADDRESS
```

Save the deployed contract address from the output.

### 2. Configure `compose.yaml`

Update with your deployed contract address:
```yaml
contract: "0xYOUR_DEPLOYED_CONTRACT_ADDRESS"
events:
  - "RandomnessRequested(uint256,address)"
```

### 3. Configure `src/tasks/fulfill-randomness.ts`

Update the target contract (same address if source and target are the same):
```typescript
const TARGET_CONTRACT = "0xYOUR_DEPLOYED_CONTRACT_ADDRESS";
```

### 4. Run locally
```bash
goldsky compose start
```

### 5. Test it

Call `requestRandomness()` on your contract:
```bash
cast send 0xYOUR_CONTRACT_ADDRESS "requestRandomness()" \
  --rpc-url https://timothy.megaeth.com/rpc \
  --private-key $PRIVATE_KEY
```

Watch the Compose logs - it should pick up the event and fulfill the request.

### 6. Deploy to Goldsky
```bash
compose deploy
```


## Project Structure

```
vrf/
├── compose.yaml                    # Compose configuration
├── contracts/
│   └── RandomnessConsumer.sol      # Example contract
├── src/
│   ├── lib/
│   │   └── drand.ts                # drand API utilities
│   └── tasks/
│       └── fulfill-randomness.ts   # Main Compose task
└── README.md
```

## Resources

- [drand Documentation](https://docs.drand.love)
- [Compose Documentation](https://docs.goldsky.com/compose/introduction)
