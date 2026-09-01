# Fireblocks webhook wallet

A Compose app that writes on-chain using a Fireblocks-held key. Compose never sees the key. It builds a gas-sponsored transaction, POSTs the unsigned payload to your signer, and submits the signature.

This path is designed, not live. Fireblocks RAW signing is a gated feature. We have not run the round trip yet.

Design page: https://fireblocks-compose-autosigner.goldsky.deno.net

## What you deploy

1. A Compose app (`compose.yaml` + the ping task). One `goldsky compose deploy`.
2. A signing server you host. Compose POSTs `{ type: "signUserOperation", userOpTypedData }` and expects `{ signature }`.
3. Fireblocks RAW signing enabled, plus a TAP rule that auto-signs RAW from one vault for one API user via the API Co-signer.

## Compose app

```ts
const wallet = await evm.webhookWallet({
  url: env.SIGN_WEBHOOK_URL,
  address: env.WALLET_ADDRESS,
  headers: { Authorization: `Bearer ${env.SIGN_WEBHOOK_TOKEN}` },
});
await wallet.writeContract(evm.chains.baseSepolia, GATED, "ping()", []);
```

That is the whole on-chain path. `writeContract` prepares the sponsored userOp, calls your signing server, and submits.

```bash
goldsky compose secret set SIGN_WEBHOOK_TOKEN --value <shared-secret>
goldsky compose deploy
```

Point `SIGN_WEBHOOK_URL` and `WALLET_ADDRESS` at your signer and Fireblocks vault in `compose.yaml`.

## Signing server

Compose POSTs:

```json
{
  "type": "signUserOperation",
  "address": "0x…",
  "chainId": 84532,
  "userOpTypedData": { "domain": {}, "types": {}, "primaryType": "PackedUserOperation", "message": {} }
}
```

Your server creates a Fireblocks RAW transaction, waits for TAP + Co-signer, and returns `{ "signature": "0x…" }`. A TAP denial should come back as HTTP 403 so Compose does not submit.

First-time wallets also get `{ "type": "signAuthorization", "authorizationRequest": { "contractAddress", "chainId", "nonce" } }`; reply with `{ address, chainId, nonce, r, s, yParity }`.

## Fireblocks RAW + TAP

RAW signing is off by default. TAP rejects RAW until a rule allows it. After Customer Success enables RAW:

1. Pair an API Co-signer with an API user that can sign.
2. Add a TAP rule: source = this vault, initiator = that API user, operation = RAW, action = auto-sign.
3. Create the RAW request:

```bash
curl -X POST https://api.fireblocks.io/v1/transactions \
  -H "X-API-Key: $FIREBLOCKS_API_KEY" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "RAW",
    "source": { "type": "VAULT_ACCOUNT", "id": "<VAULT_ID>" },
    "extraParameters": {
      "rawMessageData": {
        "messages": [{
          "content": "<hex payload from Compose>",
          "type": "EIP712"
        }]
      }
    }
  }'
```

4. Poll `GET /v1/transactions/{id}` until status is `SIGNED`. Read the signature from `signedMessages`. Do not broadcast.

Compose has to attach paymaster data before the signature exists. If RAW still broadcasts, gas sponsorship does not work.

## Open question

Turnkey could match wallet, chain, contract, and function inside an EIP-712 userOp. We have not checked whether TAP can do the same on a RAW EIP-712 payload, or only vault / API user / operation. That is the next thing to prove once RAW is on.

## Files

```
compose.yaml
src/tasks/ping.ts
```
