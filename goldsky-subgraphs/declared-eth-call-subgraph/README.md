### Declared eth_call example subgraph
This is an example implementation of a subgraph using [declared eth_calls](https://thegraph.com/docs/en/developing/creating-a-subgraph/#declared-eth_call). Declarative eth_calls are a valuable subgraph feature that allows eth_calls to be executed ahead of time which significantly improves the indexing performance.
You can find more information about this feature in the following resources:
- https://github.com/graphprotocol/graph-node/issues/5262
- https://gist.github.com/radiofreejohn/68b78d830fce11bdc910ab582de94e35 

Note: Bear in mind that declared eth_calls in your yaml file have limited scope to the `event` object of the mapping handler. This means that if you have eth_calls within util functions outside your mapping handler you'll want to make sure that the params it executes are available in the original `event` object. You can see an example of this on the eth_calls within fetchBalance() and fetchAccount() util functions

## Deploying ERC-20 subgraph to Goldsky

We'll be indexing [USDT token contract](https://taikoscan.io/token/0x9c2dc7377717603eb92b2655c5f2e7997a4945bd) on Taiko.

There are a couple of pre-requisites for deploying this subgraph:
1. Install dependencies with `npm install`
2. Make sure you have Goldsky CLI installed and pointing to your project (see [reference documentation](https://docs.goldsky.com/subgraphs/deploying-subgraphs))

The subgraph is already built, all you need to do is to deploy it onto Goldsky with the following command:
`goldsky subgraph deploy usdt-taiko-balances/1.0.0`

Alternatively, you can easily use this subgraph code to index any other ERC-20 contract by changing modifying the `subgraph.yaml` file. If do so, remember to run `npm run codegen` and `npm run build` before deploying the subgraph.

All of the code for this example was borrowed from [Chainstack](https://docs.chainstack.com/docs/subgraphs-tutorial-indexing-erc-20-token-balance).
