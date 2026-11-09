#!/usr/bin/env bash
# Deploys what Deploy.s.sol deploys, with the same CREATE2 salts and the same deployments/<chainId>.json, by sending
# the CREATE2 transactions with cast. For chains where `forge script` refuses to run (Foundry 1.5 stops with
# "Chain 133 not supported" on HashKey Chain Testnet, after the simulation succeeds).
# Usage: DEPLOYER_KEY=0x... script/deploy-create2.sh <rpc-alias-or-url> [--yes]
# Without --yes it prints the plan and sends nothing. Run from contracts/.
set -euo pipefail

RPC="${1:?usage: DEPLOYER_KEY=0x... script/deploy-create2.sh <rpc-alias-or-url> [--yes]}"
SEND="${2:-}"
FACTORY=0x4e59b44847b379578588920cA78FbF26c0B4956C
: "${DEPLOYER_KEY:?DEPLOYER_KEY is required}"

if [[ "$RPC" != http* ]]; then RPC=$(sed -n "s/^$RPC = \"\(.*\)\"$/\1/p" foundry.toml); fi
[[ -n "$RPC" ]] || { echo "unknown rpc alias" >&2; exit 2; }
CHAIN=$(cast chain-id --rpc-url "$RPC")
# Only the testnets and local anvil deploy without a second, explicit yes.
case "$CHAIN" in 133 | 11155111 | 31337) ;; *)
  [[ "$SEND" != --yes || "${CONFIRM_MAINNET:-}" == yes ]] || { echo "chain $CHAIN is not a known testnet: set CONFIRM_MAINNET=yes to deploy there" >&2; exit 2; } ;;
esac

# Whether an address has code. An RPC failure stops the script: read as "no code", it would send a colliding CREATE2.
has_code() {
  local c
  c=$(cast code "$1" --rpc-url "$RPC") || { echo "RPC error reading the code at $1; try again" >&2; exit 1; }
  [[ -n "$c" && "$c" != 0x ]]
}
has_code $FACTORY || { echo "no CREATE2 deployer on chain $CHAIN" >&2; exit 2; }

forge build --quiet
OUT="deployments/$CHAIN.json"
FROM=$(cast wallet address --private-key "$DEPLOYER_KEY")
echo "chain $CHAIN, deployer $FROM ($(cast balance "$FROM" --rpc-url "$RPC" -e) native)"

# contract:salt-label:json-address-key:json-block-key
ITEMS=("ClearingHub:payminto.clearing.v1:clearingHub:blockNumber"
  "DepositFactory:payminto.deposits.v1:depositFactory:depositFactoryBlock"
  "PaymentRouter:payminto.router.v1:paymentRouter:paymentRouterBlock")
[[ "$CHAIN" == 133 ]] && ITEMS+=("TestnetStablecoin:payminto.testnet-usdc.v1:token:")

# Merges fields into deployments/<chainId>.json in Deploy.s.sol's key order, after every deploy, so a run that fails
# halfway can be resumed: the next run finds the contracts it already deployed recorded with their blocks.
record() {
  mkdir -p deployments
  node -e '
const fs = require("fs"); const [out, chainId, ...kv] = process.argv.slice(1);
const j = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : {};
j.chainId = +chainId;
for (let i = 0; i < kv.length; i += 2) j[kv[i]] = /Block$|^blockNumber$/.test(kv[i]) ? +kv[i + 1] : kv[i + 1];
const order = ["blockNumber", "chainId", "clearingHub", "depositFactory", "depositFactoryBlock", "depositForwarderImplementation", "paymentRouter", "paymentRouterBlock", "token"];
const sorted = Object.fromEntries(order.filter((k) => k in j).map((k) => [k, j[k]]));
fs.writeFileSync(out, JSON.stringify(sorted, null, 2) + "\n");
' "$OUT" "$CHAIN" "$@"
}

recorded_block() { [[ -f "$OUT" ]] && node -e "const j=require('./$OUT');const a=j[process.argv[1]],b=j[process.argv[2]];if(a&&a.toLowerCase()===process.argv[3].toLowerCase()&&b!==undefined)console.log(b)" "$1" "$2" "$3" || true; }

# Plain ADDR_<key> and BLOCK_<key> variables: macOS ships bash 3.2, which has no associative arrays.
setv() { printf -v "$1" "%s" "$2"; }
getv() { local n=$1; echo "${!n:-}"; }
for item in "${ITEMS[@]}"; do
  IFS=: read -r name label key bkey <<<"$item"
  code=$(forge inspect "$name" bytecode)
  salt=$(cast keccak "$label")
  at=$(cast create2 --deployer $FACTORY --salt "$salt" --init-code-hash "$(cast keccak "$code")" | tail -1)
  setv "ADDR_$key" "$at"
  if has_code "$at"; then
    if [[ -n "$bkey" ]]; then
      b=$(recorded_block "$key" "$bkey" "$at")
      [[ -n "$b" ]] || { echo "$name already has code at $at but $OUT does not record its block; restore the file" >&2; exit 1; }
      setv "BLOCK_$bkey" "$b"
    fi
    echo "  $name $at: already deployed, keeping it"
    continue
  fi
  echo "  $name $at: to deploy"
  if [[ "$SEND" == --yes ]]; then
    receipt=$(cast send $FACTORY "${salt}${code#0x}" --private-key "$DEPLOYER_KEY" --rpc-url "$RPC" --json)
    [[ "$(echo "$receipt" | node -e "console.log(JSON.parse(require('fs').readFileSync(0)).status)")" == 0x1 ]] || { echo "$name deploy reverted" >&2; exit 1; }
    # Public RPCs are load-balanced: the node answering next may not have the block yet, so wait for the code.
    for _ in $(seq 1 90); do has_code "$at" && break; sleep 2; done
    has_code "$at" || { echo "$name: no code at $at 180 s after deploy" >&2; exit 1; }
    block=$(echo "$receipt" | node -e "console.log(Number(JSON.parse(require('fs').readFileSync(0)).blockNumber))")
    if [[ -n "$bkey" ]]; then setv "BLOCK_$bkey" "$block"; record "$key" "$at" "$bkey" "$block"; else record "$key" "$at"; fi
    echo "    tx $(echo "$receipt" | node -e "console.log(JSON.parse(require('fs').readFileSync(0)).transactionHash)")"
  fi
done
[[ "$SEND" == --yes ]] || { echo "Dry run. Add --yes to send."; exit 0; }

impl=$(cast call "$(getv ADDR_depositFactory)" "implementation()(address)" --rpc-url "$RPC")
fields=(clearingHub "$(getv ADDR_clearingHub)" blockNumber "$(getv BLOCK_blockNumber)"
  depositFactory "$(getv ADDR_depositFactory)" depositFactoryBlock "$(getv BLOCK_depositFactoryBlock)"
  depositForwarderImplementation "$impl" paymentRouter "$(getv ADDR_paymentRouter)" paymentRouterBlock "$(getv BLOCK_paymentRouterBlock)")
[[ -n "$(getv ADDR_token)" ]] && fields+=(token "$(getv ADDR_token)")
record "${fields[@]}"
echo "wrote $OUT"
