#!/usr/bin/env bash
# Deploy MockUSDC + ShareToken + DistributionCampaign to Base mainnet.
#
# Usage:
#   PRIVATE_KEY=0x... ./scripts/deploy.sh
#
# Outputs each address to stdout in a `KEY=value` block. Copy them into
# src/lib/constants.ts and re-deploy the compose app.
#
# Defaults can be overridden:
#   RPC_URL=...                  (default: https://mainnet.base.org)
#   HOLDERS_FILE=...             (default: scripts/seed-holders.json)

set -euo pipefail

if [[ -z "${PRIVATE_KEY:-}" ]]; then
  echo "PRIVATE_KEY env var required (deployer wallet, must hold a small amount of ETH on Base)" >&2
  exit 1
fi

RPC_URL="${RPC_URL:-https://mainnet.base.org}"
HOLDERS_FILE="${HOLDERS_FILE:-scripts/seed-holders.json}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! -f "$ROOT_DIR/$HOLDERS_FILE" ]]; then
  echo "Holders file not found: $ROOT_DIR/$HOLDERS_FILE" >&2
  exit 1
fi

# Build constructor args for ShareToken from seed-holders.json.
# Forge expects unquoted-element array form: [0x...,0x...,...] for address[]
# and [1000,1000,...] for uint256[].
HOLDERS_ARG="$(jq -r '"[" + ([.holders[].address] | join(",")) + "]"' "$ROOT_DIR/$HOLDERS_FILE")"
AMOUNTS_ARG="$(jq -r '"[" + ([.holders[].amount] | join(",")) + "]"' "$ROOT_DIR/$HOLDERS_FILE")"
COUNT="$(jq -r '.holders | length' "$ROOT_DIR/$HOLDERS_FILE")"
echo "ShareToken pre-mint: $COUNT holders"

echo "Deploying to $RPC_URL ..."
echo

deploy() {
  local contract="$1"
  shift
  local logfile
  logfile="$(mktemp)"
  # Mirror forge's output to the user's stdout AND a temp log we can grep,
  # avoiding pipefail/SIGPIPE issues when capturing inside $().
  forge create "$contract" \
    --rpc-url "$RPC_URL" \
    --private-key "$PRIVATE_KEY" \
    --broadcast \
    --root "$ROOT_DIR" \
    "$@" \
    | tee "$logfile" >&2
  local addr
  addr="$(awk '/^Deployed to:/ { print $3; exit }' "$logfile")"
  rm -f "$logfile"
  if [[ -z "$addr" ]]; then
    echo "deploy of $contract did not report a deployed address" >&2
    exit 1
  fi
  echo "$addr"
}

USDC_ADDR="$(deploy contracts/MockUSDC.sol:MockUSDC)"
echo "MockUSDC=$USDC_ADDR"

SHARE_ADDR="$(deploy contracts/ShareToken.sol:ShareToken \
  --constructor-args "$HOLDERS_ARG" "$AMOUNTS_ARG")"
echo "ShareToken=$SHARE_ADDR"

CAMPAIGN_ADDR="$(deploy contracts/DistributionCampaign.sol:DistributionCampaign)"
echo "DistributionCampaign=$CAMPAIGN_ADDR"

echo
echo "Update src/lib/constants.ts with:"
cat <<EOF

  payToken:         "$USDC_ADDR" as Hex,
  shareToken:       "$SHARE_ADDR" as Hex,
  campaignContract: "$CAMPAIGN_ADDR" as Hex,

EOF

echo "Then mint MockUSDC to your operator wallet (printed when the cron task starts):"
echo "  cast send $USDC_ADDR \"mint(address,uint256)\" <OPERATOR> 1000000000000 \\"
echo "    --rpc-url $RPC_URL --private-key \$PRIVATE_KEY"
