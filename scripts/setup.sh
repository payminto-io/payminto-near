#!/usr/bin/env bash
# One-step setup for Payminto: checks Node.js and pnpm, then installs the workspace.
# It installs nothing globally, needs no account or key, and touches nothing outside this folder.
# Usage: ./scripts/setup.sh
set -euo pipefail

cd "$(dirname "$0")/.."

say() { printf '%s\n' "$*"; }
fail() { printf 'setup: %s\n' "$*" >&2; exit 1; }

# 1. Node.js 22.18 or newer: the node runs TypeScript with Node's built-in type stripping and uses node:sqlite.
command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Install Node.js 22.18 or newer (https://nodejs.org, or 'nvm install' in this folder reads .nvmrc), then run this again."
node apps/node/scripts/check-runtime.mjs || exit 1
say "Node.js $(node --version): ok"

# 2. pnpm 9, the version pinned in package.json.
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    fail "pnpm is not installed. Run 'corepack enable pnpm' (or 'npm install -g pnpm@9'), then run this again."
  fi
  fail "pnpm is not installed. Run 'npm install -g pnpm@9', then run this again."
fi
pnpm_major="$(pnpm --version | cut -d. -f1)"
[ "$pnpm_major" -ge 9 ] 2>/dev/null || fail "pnpm $(pnpm --version) is too old. Install pnpm 9 ('npm install -g pnpm@9'), then run this again."
say "pnpm $(pnpm --version): ok"

# 3. Install exactly what the lockfile pins.
say "Installing dependencies (pnpm install --frozen-lockfile)..."
pnpm install --frozen-lockfile

say ""
say "Setup done. Next:"
say "  pnpm local    the whole product in your browser, on a local NEAR node (first start about 2 minutes)"
say "  pnpm demo     the whole story in a terminal, in about 5 seconds"
say "  pnpm swarm    25 agents trading in sealed-bid rounds, in about 5 seconds"
