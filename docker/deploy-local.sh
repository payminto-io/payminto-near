#!/bin/sh
# One-shot local deployment for `docker compose --profile local up`: deploys ClearingHub and MockStablecoin to the
# anvil service with the public anvil key 0. Idempotent: skips when the recorded hub still has code on this chain.
# Refuses anything that is not chain 31337, so it can never spend real money.
set -eu

RPC_URL="${RPC_URL:-http://anvil:8545}"
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" # anvil key 0, public
FILE=deployments/31337.json

chain="$(cast chain-id --rpc-url "$RPC_URL")"
if [ "$chain" != "31337" ]; then
  echo "refusing: $RPC_URL is chain $chain, the local deployer only runs against anvil (31337)" >&2
  exit 1
fi

if [ -f "$FILE" ]; then
  hub="$(sed -n 's/.*"clearingHub": *"\(0x[0-9a-fA-F]\{40\}\)".*/\1/p' "$FILE")"
  if [ -n "$hub" ] && [ "$(cast code "$hub" --rpc-url "$RPC_URL")" != "0x" ]; then
    echo "hub $hub already deployed, nothing to do"
    exit 0
  fi
fi

forge script script/DeployLocal.s.sol --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_KEY"
cat "$FILE"
