#!/usr/bin/env bash
#
# Secret Garden — DEVNET post-deploy verification (READ-ONLY).
# Sends no transactions and spends nothing. Safe to run repeatedly.
# Not wired into CI — manual reference only.
#
#   HELIUS_RPC_URL=... ./scripts/devnet-verify.sh
#
# Checks: (1) program account is deployed & executable, (2) GameConfig readable with
# expected initial values, (3) all 3 comp defs registered. (2)+(3) run through the
# read-only scripts/devnet-verify.ts via mocha.

set -euo pipefail
cd "$(dirname "$0")/.."

PROGRAM_ID="7eMfGCkXavfZeVrwRo3ZH63C7H6mZ6n1HZKJwGkZBddo"
DEVNET_WALLET="${DEVNET_WALLET:-$HOME/.config/solana/devnet-wallet.json}"

if [[ -z "${HELIUS_RPC_URL:-}" ]]; then
  echo "ERROR: HELIUS_RPC_URL is not set." >&2; exit 1
fi

echo "== 1. program account (executable?) =="
solana program show "$PROGRAM_ID" --url "$HELIUS_RPC_URL"

echo "== 2+3. GameConfig + comp defs (read-only fetches) =="
ANCHOR_PROVIDER_URL="$HELIUS_RPC_URL" \
ANCHOR_WALLET="$DEVNET_WALLET" \
ARCIUM_CLUSTER_OFFSET="456" \
  npx mocha --no-config --timeout 120000 scripts/devnet-verify.ts

echo "VERIFY complete."
