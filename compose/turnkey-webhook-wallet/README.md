# Turnkey webhook wallet

A Compose app that writes on-chain using a Turnkey-held key. Compose never sees the key. It builds a gas-sponsored transaction, POSTs the unsigned payload to your signer, and submits the signature.

Live demo: https://turnkey-compose-autosigner.goldsky.deno.net

## What you deploy

1. A Compose app (`compose.yaml` + the two tasks). One `goldsky compose deploy`.
2. A signing webhook you host. Compose POSTs `{ type: "signUserOperation", userOpTypedData }` and expects `{ signature }`.
3. Three Turnkey policies in the customer's sub-org. The customer's root user creates them; Compose cannot.

## Compose app

```ts
const wallet = await evm.webhookWallet({
  url: env.SIGN_WEBHOOK_URL,
  address: env.WALLET_ADDRESS,
  headers: { Authorization: `Bearer ${env.SIGN_WEBHOOK_TOKEN}` },
});
await wallet.writeContract(evm.chains.baseSepolia, GATED, "ping()", []);
```

That is the whole on-chain path. `writeContract` prepares the sponsored userOp, calls your webhook, and submits.

```bash
goldsky compose secret set SIGN_WEBHOOK_TOKEN --value <shared-secret>
goldsky compose deploy
```

Point `SIGN_WEBHOOK_URL` and `WALLET_ADDRESS` at your signer and Turnkey wallet in `compose.yaml`.

## Turnkey policies

The policies are derived from the `writeContract` calls in the app: wallet, chain, contract, function. The JSON in `policies.json` is what this demo's `ping()` task needs.

Create each policy with the Turnkey API (stamp the request with the customer's root API key):

```bash
curl -X POST https://api.turnkey.com/public/v1/submit/create_policy \
  -H "Content-Type: application/json" \
  -H "X-Stamp: <root-api-stamp>" \
  -d '{
    "type": "ACTIVITY_TYPE_CREATE_POLICY_V3",
    "timestampMs": "'$(date +%s000)'",
    "organizationId": "<SUB_ORG_ID>",
    "parameters": {
      "policyName": "compose-auto-sign-userops-v1",
      "effect": "EFFECT_ALLOW",
      "consensus": "approvers.any(user, user.id == '\''<COMPOSE_USER_ID>'\'')",
      "condition": "<condition from policies.json>",
      "notes": "ping() only"
    }
  }'
```

Repeat for the 7702-delegation ALLOW policy and the opaque-payload DENY policy. The customer's root quorum is the one that signs this. After that, matching transactions auto-sign; everything else is denied.

## Signing webhook

Compose POSTs:

```json
{
  "type": "signUserOperation",
  "address": "0x…",
  "chainId": 84532,
  "userOpTypedData": { "domain": {}, "types": {}, "primaryType": "PackedUserOperation", "message": {} }
}
```

Your webhook asks Turnkey to sign that typed data and returns `{ "signature": "0x…" }`. First-time wallets also get `{ "type": "signAuthorization", "authorizationRequest": { "contractAddress", "chainId", "nonce" } }`; reply with `{ address, chainId, nonce, r, s, yParity }`.

A 403 from the webhook is a policy denial. Compose does not submit.

## Files

```
compose.yaml
src/tasks/ping.ts
src/tasks/forbidden.ts
policies.json
```
