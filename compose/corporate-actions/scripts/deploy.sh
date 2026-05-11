#!/usr/bin/env bash
# Deploy contracts to Base mainnet.
#
# Usage:
#   PRIVATE_KEY=0x... ./scripts/deploy.sh                  # all three (initial setup)
#   PRIVATE_KEY=0x... ./scripts/deploy.sh share-token      # ShareToken only (re-seed holders)
#
# In `all` mode, deploys MockUSDC + ShareToken + DistributionCampaign.
# In `share-token` mode, deploys only ShareToken — pre-mints to whatever
# distribution `seed-holders.json` currently contains. Use this when you
# want to refresh the holder distribution without touching the campaign
# contract or the pay-token. The script prints the new address AND the
# block it was deployed at, both of which need to land in
# src/lib/constants.ts (shareToken + shareTokenDeployBlock).
#
# Defaults can be overridden:
#   RPC_URL=...                  (default: https://mainnet.base.org)
#   HOLDERS_FILE=...             (default: scripts/seed-holders.json)

set -euo pipefail

MODE="${1:-all}"
case "$MODE" in
  all|share-token) ;;
  *) echo "Unknown mode: $MODE (expected 'all' or 'share-token')" >&2; exit 1 ;;
esac

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
echo "Deploying to $RPC_URL (mode: $MODE) ..."
echo

# deploy <contract> [extra forge args...]
# Echoes "<address>|<txhash>" to stdout. Mirrors forge output to stderr
# so the user sees progress without contaminating capture.
deploy() {
  local contract="$1"
  shift
  local logfile
  logfile="$(mktemp)"
  forge create "$contract" \
    --rpc-url "$RPC_URL" \
    --private-key "$PRIVATE_KEY" \
    --broadcast \
    --root "$ROOT_DIR" \
    "$@" \
    | tee "$logfile" >&2
  local addr txhash
  addr="$(awk '/^Deployed to:/ { print $3; exit }' "$logfile")"
  txhash="$(awk '/^Transaction hash:/ { print $3; exit }' "$logfile")"
  rm -f "$logfile"
  if [[ -z "$addr" ]]; then
    echo "deploy of $contract did not report a deployed address" >&2
    exit 1
  fi
  echo "${addr}|${txhash}"
}

# Look up the block number a tx landed in. Used to set
# shareTokenDeployBlock so the snapshot pipeline's filter can prune
# pre-deploy blocks.
block_of() {
  local txhash="$1"
  cast receipt "$txhash" --rpc-url "$RPC_URL" --json \
    | jq -r '.blockNumber' \
    | python3 -c 'import sys; print(int(sys.stdin.read().strip(), 0))'
}

if [[ "$MODE" == "share-token" ]]; then
  IFS='|' read -r SHARE_ADDR SHARE_TX <<<"$(deploy contracts/ShareToken.sol:ShareToken \
    --constructor-args "$HOLDERS_ARG" "$AMOUNTS_ARG")"
  SHARE_BLOCK="$(block_of "$SHARE_TX")"
  echo
  echo "ShareToken=$SHARE_ADDR"
  echo "shareTokenDeployBlock=$SHARE_BLOCK"
  echo
  echo "Update src/lib/constants.ts with:"
  cat <<EOF

  shareToken:            "$SHARE_ADDR" as Hex,
  shareTokenDeployBlock: $SHARE_BLOCK,

EOF
  echo "Then redeploy the compose app:"
  echo "  goldsky compose deploy -t cmlvmcgu3c5kz01z07szaagyb"
  exit 0
fi

# --- all mode: deploy MockUSDC + ShareToken + DistributionCampaign ---

IFS='|' read -r USDC_ADDR _ <<<"$(deploy contracts/MockUSDC.sol:MockUSDC)"
echo "MockUSDC=$USDC_ADDR"

IFS='|' read -r SHARE_ADDR SHARE_TX <<<"$(deploy contracts/ShareToken.sol:ShareToken \
  --constructor-args "$HOLDERS_ARG" "$AMOUNTS_ARG")"
SHARE_BLOCK="$(block_of "$SHARE_TX")"
echo "ShareToken=$SHARE_ADDR"
echo "shareTokenDeployBlock=$SHARE_BLOCK"

IFS='|' read -r CAMPAIGN_ADDR _ <<<"$(deploy contracts/DistributionCampaign.sol:DistributionCampaign)"
echo "DistributionCampaign=$CAMPAIGN_ADDR"

echo
echo "Update src/lib/constants.ts with:"
cat <<EOF

  payToken:              "$USDC_ADDR" as Hex,
  shareToken:            "$SHARE_ADDR" as Hex,
  campaignContract:      "$CAMPAIGN_ADDR" as Hex,
  shareTokenDeployBlock: $SHARE_BLOCK,

EOF

echo "Then mint MockUSDC to your operator wallet (printed when the cron task starts):"
echo "  cast send $USDC_ADDR \"mint(address,uint256)\" <OPERATOR> 1000000000000 \\"
echo "    --rpc-url $RPC_URL --private-key \$PRIVATE_KEY"
