#!/bin/sh
# Builds out/hub.wasm and out/mock_ft.wasm with the pinned toolchain (rust-toolchain.toml) and cargo-near 0.23.0.
#
# The registry sources live under $CARGO_HOME, which is usually inside the builder's home directory, and rustc embeds
# their paths in panic locations. Remapping $CARGO_HOME to /cargo keeps every home path out of the wasm, so the bytes
# and the code hash depend only on the sources, Cargo.lock and the toolchain, not on who built them or where.
# cargo-near ignores RUSTFLAGS from the shell and from .cargo/config.toml, so the remap goes through its --env flag.
#
# Usage, from anywhere: sh contracts-near/build.sh
set -eu

cd "$(dirname "$0")"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
case "$cargo_home" in
  *" "*) echo "CARGO_HOME must not contain spaces: $cargo_home" >&2; exit 1 ;;
esac
flags="RUSTFLAGS=-C link-arg=-s --remap-path-prefix=$cargo_home=/cargo"

cargo near build non-reproducible-wasm --locked --env "$flags"
cargo near build non-reproducible-wasm --locked --env "$flags" --manifest-path mock_ft/Cargo.toml
cp target/near/payminto_hub.wasm out/hub.wasm
cp target/near/mock_ft/mock_ft.wasm out/mock_ft.wasm

for wasm in out/hub.wasm out/mock_ft.wasm; do
  if strings -n 6 "$wasm" | grep -qF -e "$cargo_home" -e "$HOME/"; then
    echo "$wasm still contains a path from $cargo_home or $HOME" >&2
    exit 1
  fi
done
shasum -a 256 out/hub.wasm out/mock_ft.wasm
