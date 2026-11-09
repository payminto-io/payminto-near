#!/usr/bin/env bash
# Verifies the deployed ClearingHub, DepositFactory, DepositForwarder implementation and PaymentRouter sources on
# HashKey Chain.
# Usage: script/verify.sh <133|177> [hub-address] [deposit-factory-address] [payment-router-address]
# Addresses default to deployments/<chainId>.json; the forwarder implementation is read from the factory on chain.
# Tries Blockscout first, then falls back to Sourcify.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

CHAIN_ID="${1:-}"
case "$CHAIN_ID" in
  177) VERIFIER_URL="https://hsk.blockscout.com/api/"; RPC_URL="https://mainnet.hsk.xyz" ;;
  133) VERIFIER_URL="https://testnet-explorer.hskchain.net/api/"; RPC_URL="https://testnet.hsk.xyz" ;;
  *)
    echo "usage: script/verify.sh <133|177> [hub-address] [deposit-factory-address] [payment-router-address]" >&2
    exit 64
    ;;
esac

FILE="deployments/${CHAIN_ID}.json"

# Reads an address field from the deployments file.
from_deployments() {
  local key="$1" value
  [[ -f "$FILE" ]] || { echo "no $FILE and no $key address given" >&2; exit 1; }
  value="$(sed -n "s/.*\"$key\": *\"\(0x[0-9a-fA-F]\{40\}\)\".*/\1/p" "$FILE")"
  [[ -n "$value" ]] || { echo "could not read $key from $FILE" >&2; exit 1; }
  echo "$value"
}

verify() {
  local address="$1" contract="$2"
  echo "verifying $contract at $address on chain $CHAIN_ID"
  if forge verify-contract "$address" "$contract" --chain "$CHAIN_ID" --verifier blockscout --verifier-url "$VERIFIER_URL" --watch; then
    echo "verified on Blockscout ($VERIFIER_URL)"
    return 0
  fi
  echo "Blockscout verification failed, falling back to Sourcify" >&2
  forge verify-contract "$address" "$contract" --chain "$CHAIN_ID" --verifier sourcify --watch
  echo "verified on Sourcify"
}

HUB="${2:-$(from_deployments clearingHub)}"
FACTORY="${3:-$(from_deployments depositFactory)}"
ROUTER="${4:-$(from_deployments paymentRouter)}"
IMPLEMENTATION="$(cast call "$FACTORY" "implementation()(address)" --rpc-url "$RPC_URL")"

verify "$HUB" "src/ClearingHub.sol:ClearingHub"
verify "$FACTORY" "src/DepositFactory.sol:DepositFactory"
verify "$IMPLEMENTATION" "src/DepositForwarder.sol:DepositForwarder"
verify "$ROUTER" "src/PaymentRouter.sol:PaymentRouter"
