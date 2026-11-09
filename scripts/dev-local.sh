#!/usr/bin/env bash
# Local dev loop: anvil (started if not running) + ClearingHub/MockStablecoin/DepositFactory/PaymentRouter deploy + Clearing Node.
# Uses public anvil dev keys only: key 0 deploys, key 9 is the node OPERATOR_KEY. Never point this at a live network.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
ANVIL_PORT="${RPC_URL##*:}"
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"   # anvil key 0
OPERATOR_KEY_DEV="0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6" # anvil key 9
DEPLOYMENT="$ROOT/contracts/deployments/31337.json"
ANVIL_PID=""

cleanup() {
  if [[ -n "$ANVIL_PID" ]]; then
    echo "stopping anvil ($ANVIL_PID)"
    kill "$ANVIL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

for bin in anvil forge cast node pnpm; do
  command -v "$bin" >/dev/null || { echo "missing $bin on PATH" >&2; exit 1; }
done

if ! cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1; then
  mkdir -p "$ROOT/apps/node/data"
  echo "starting anvil on port $ANVIL_PORT (log: apps/node/data/anvil.log)"
  anvil --port "$ANVIL_PORT" >"$ROOT/apps/node/data/anvil.log" 2>&1 &
  ANVIL_PID=$!
  for _ in $(seq 1 100); do
    cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 && break
    sleep 0.1
  done
fi

CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL")"
if [[ "$CHAIN_ID" != "31337" ]]; then
  echo "refusing: $RPC_URL is chain $CHAIN_ID, dev-local.sh only runs against a local anvil (31337)" >&2
  exit 1
fi

has_code() {
  local address
  address="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]]??"")}catch{}' "$DEPLOYMENT" "$1")"
  [[ -n "$address" ]] && [[ "$(cast code "$address" --rpc-url "$RPC_URL")" != "0x" ]]
}

# A deployment from before the gateway has no depositFactory or paymentRouter: redeploy everything so the file stays consistent.
if ! has_code clearingHub || ! has_code depositFactory || ! has_code paymentRouter; then
  echo "deploying ClearingHub + MockStablecoin + DepositFactory + PaymentRouter"
  (cd "$ROOT/contracts" && forge script script/DeployLocal.s.sol --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_KEY" >/dev/null)
fi
HUB="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).clearingHub)' "$DEPLOYMENT")"
TOKEN="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token)' "$DEPLOYMENT")"
echo "hub $HUB token $TOKEN"

# One SQLite file per deployment: a database never mixes hubs (the node refuses that anyway).
export DB_PATH="${DB_PATH:-$ROOT/apps/node/data/dev-31337-${HUB:2:8}.db}"
export CHAIN_ID=31337
export RPC_URL
export OPERATOR_KEY="${OPERATOR_KEY:-$OPERATOR_KEY_DEV}"
export ADMIN_TOKEN="${ADMIN_TOKEN:-dev-admin-token}"
export PUBLIC_URL="${PUBLIC_URL:-http://localhost:${PORT:-8787}}"

echo "starting clearing node (DB_PATH=$DB_PATH, ADMIN_TOKEN=dev-admin-token)"
cd "$ROOT"
if [[ -n "$ANVIL_PID" ]]; then
  pnpm --filter @payminto/node dev
else
  exec pnpm --filter @payminto/node dev
fi
