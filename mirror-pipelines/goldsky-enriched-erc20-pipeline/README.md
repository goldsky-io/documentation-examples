### Enriched ERC20 Tranfers Pipeline

This repo contains the definition of a Goldsky Mirror pipeline that streams ERC20 Transfer events from a set of tokens into a ClickHouse database.

The pipeline uses [HTTP Handler Transforms](https://docs.goldsky.com/mirror/extensions/transforms#2-external-handler-transforms-new) to interact with a local NodeJS Express server that enrichs the events data with token information (symbol and decimal) for the tokens DAI, USDC, USDT, BUSD and LDO on mainnet. This local service mocks an external DB containing the token metadata; in practice, you can use the same logic and replace it with real APIs like CoinGecko.

This implementation pipeline shows how you can use [schemaOverrides](https://docs.goldsky.com/mirror/extensions/transforms#schema-override-datatypes) on the transform to change the shape of the data in the sink: it nullifies some of the columns in the ERC-20 dataset (see [schema here](https://docs.goldsky.com/reference/schema/curated-schemas#erc-20)) and adds new columns `token_address`, `token_symbol`, `token_decimals` and `converted_amount`.


### Pre-requisites
- Node
- Goldsky CLI installed and pointing to your project ([see instructions](https://docs.goldsky.com/introduction))

### Set up

In order to run the server locally you can:
1. Install dependencies with  `npm install`
2. Start the server with `npm start`
3. Expose the server to the public internet so that it's reachable by the pipeline. An easy option is to use [ngrok tunnel](https://ngrok.com/). You can also host it externally if you prefer (e.g. Lambda)
4. Replace HTTP Transform url in pipeline definition with your public URL
5. Replace [sink](https://docs.goldsky.com/mirror/sinks/supported-sinks) in pipeline definition with your desired sink 





