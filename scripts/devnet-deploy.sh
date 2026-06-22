#!/usr/bin/env bash
#
# Secret Garden — DEVNET deployment driver (MANUAL, phased).
# Program ID: 7eMfGCkXavfZeVrwRo3ZH63C7H6mZ6n1HZKJwGkZBddo
#
# This script is NOT wired into CI and never runs end-to-end on its own. You invoke
# ONE phase at a time and read the output before moving on. Phase order:
#
#   ./scripts/devnet-deploy.sh preflight   # read-only sanity checks, spends nothing
#   ./scripts/devnet-deploy.sh build       # local arcium build, spends nothing
#   ./scripts/devnet-deploy.sh deploy      # >>> SPENDS SOL <<< program + MXE init (~6-11.5)
#   ./scripts/devnet-deploy.sh canary      # >>> SPENDS SOL <<< config + breed ONLY (~3.05)
#                                          #     == the Enc<Mxe>-on-cluster-456 go/no-go gate
#   #  --- developer reviews canary result; only proceed if it PASSED ---
#   CANARY_PASSED=yes ./scripts/devnet-deploy.sh setup   # >>> SPENDS SOL <<< score_entry + reveal_top3 (~4.34)
#
# WHY canary before setup: all 3 circuits take Enc<Mxe> as input and re-read persisted
# Enc<Mxe> via ArgBuilder::account(). A prior note flagged cluster 456 aborting that
# pattern. `breed` is the cheapest circuit that can run FIRST and exercises that exact
# primitive (it reads parent genomes via .account()), so it is the minimal real test.
# score_entry/reveal_top3 cannot be tested earlier — their Enc<Mxe> inputs only exist
# once breed has produced a genome. So we register breed, prove the pattern, and ONLY
# THEN spend ~4.34 SOL on the remaining two circuits.
#
# Every devnet phase targets $HELIUS_RPC_URL explicitly — the global solana CLI config
# defaults to PUBLIC devnet, which we never use for deploy/init.
#
# Required environment (export before a devnet phase):
#   HELIUS_RPC_URL   full Helius devnet RPC URL incl. api key (NEVER hardcode it here)
#   DEVNET_WALLET    path to the funded operator keypair == the GAME AUTHORITY.
#                    Default below is ~/.config/solana/id.json because the canary reuses
#                    tests/breeding.ts, which hardcodes id.json as the authority/player.
#                    >> This SAME wallet must be funded on devnet AND used for deploy,
#                       canary, and setup so GameConfig.authority stays consistent. <<
#
# Verified against docs.arcium.com (Arcium v0.10.4): deploy uses `arcium deploy`
# (NOT `solana program deploy`); devnet shared cluster offset = 456; circuits are
# uploaded on-chain as a separate post-deploy step via the program's own instructions.

set -euo pipefail

# --- config knobs -----------------------------------------------------------------
PROGRAM_ID="7eMfGCkXavfZeVrwRo3ZH63C7H6mZ6n1HZKJwGkZBddo"
PROGRAM_KEYPAIR="target/deploy/secret_garden-keypair.json"
CLUSTER_OFFSET="456"        # shared devnet ARX cluster (VERIFY still 456 post-restart)
RECOVERY_SET_SIZE="4"       # arcium deploy minimum
# Game authority + payer for canary/setup. MUST equal the wallet that inits GameConfig
# (the canary) so later comp-def registrations pass the authority check. See header.
DEVNET_WALLET="${DEVNET_WALLET:-$HOME/.config/solana/id.json}"

cd "$(dirname "$0")/.."     # repo root

require_helius() {
  if [[ -z "${HELIUS_RPC_URL:-}" ]]; then
    echo "ERROR: HELIUS_RPC_URL is not set. export it first (do not hardcode the key)." >&2
    exit 1
  fi
}

phase_preflight() {
  echo "== PREFLIGHT (read-only, spends nothing) =="
  arcium --version; anchor --version; solana --version
  echo "- program id in source must equal $PROGRAM_ID:"
  grep declare_id programs/secret-garden/src/lib.rs
  echo "- program keypair derives:"; solana-keygen pubkey "$PROGRAM_KEYPAIR"
  echo "- devnet cluster version (RC compatibility eyeball):"
  solana cluster-version --url devnet
  echo "- GAME AUTHORITY wallet ($DEVNET_WALLET) balance on devnet (need ~20+ SOL):"
  solana balance "$DEVNET_WALLET" --url devnet || echo "  (if low/zero: fund THIS keypair on devnet — it is the authority the canary will use)"
  echo "- circuits present for on-chain upload:"
  ls -la build/breed.arcis build/score_entry.arcis build/reveal_top3.arcis
  echo "PREFLIGHT done. Nothing spent. Next: build"
}

phase_build() {
  echo "== BUILD (local, spends nothing) =="
  arcium build
  echo "- confirm program id did NOT regenerate:"
  solana-keygen pubkey "$PROGRAM_KEYPAIR"; grep declare_id programs/secret-garden/src/lib.rs
  echo "BUILD done. If id is still $PROGRAM_ID, next: deploy"
}

phase_deploy() {
  require_helius
  echo "== DEPLOY (>>> SPENDS ~6-11.5 SOL <<<): program binary + MXE account =="
  echo "RPC: \$HELIUS_RPC_URL (masked)   wallet: $DEVNET_WALLET   offset: $CLUSTER_OFFSET"
  echo "Ctrl-C to abort. Sleeping 5s..."; sleep 5
  # Deploys the program AND initializes the MXE account. Re-run with --resume if interrupted.
  arcium deploy \
    --cluster-offset "$CLUSTER_OFFSET" \
    --recovery-set-size "$RECOVERY_SET_SIZE" \
    --program-keypair "$PROGRAM_KEYPAIR" \
    --keypair-path "$DEVNET_WALLET" \
    --rpc-url "$HELIUS_RPC_URL"
  echo "DEPLOY done. NEXT: canary  (do NOT skip to setup — canary is the Enc<Mxe> gate)"
}

phase_canary() {
  require_helius
  echo "== CANARY (>>> SPENDS ~3.05 SOL <<<): GameConfig + breed comp-def ONLY =="
  echo "This is the Enc<Mxe>-on-cluster-456 go/no-go. It runs the PROVEN tests/breeding.ts"
  echo "against devnet: it inits config, registers+uploads ONLY the breed circuit, then"
  echo "breeds (incl. test 2 that re-reads a REAL stored Enc<Mxe> genome via .account())."
  echo "It does NOT register score_entry or reveal_top3."
  echo
  echo "NOTE: breeding.ts uses ~/.config/solana/id.json as authority/player. DEVNET_WALLET"
  echo "      is currently: $DEVNET_WALLET — these MUST be the same funded keypair."
  echo "Ctrl-C to abort. Sleeping 5s..."; sleep 5
  ANCHOR_PROVIDER_URL="$HELIUS_RPC_URL" \
  ANCHOR_WALLET="$DEVNET_WALLET" \
  ARCIUM_CLUSTER_OFFSET="$CLUSTER_OFFSET" \
    npx mocha --no-config --timeout 1800000 tests/breeding.ts
  echo
  echo "CANARY finished. >>> REVIEW THE RESULT YOURSELF. <<<"
  echo "  PASS  = all breeding tests passed, esp. '(2) Encrypted parent reads stored"
  echo "          ciphertext via account()'. Enc<Mxe> works on 456. Proceed:"
  echo "            CANARY_PASSED=yes ./scripts/devnet-deploy.sh setup"
  echo "  FAIL  = computation aborted / never finalized / wrong result. DO NOT run setup."
  echo "          See docs/DEVNET_DEPLOYMENT.md §5 'If the canary fails'."
}

phase_setup() {
  require_helius
  if [[ "${CANARY_PASSED:-}" != "yes" ]]; then
    echo "REFUSING to run setup: canary not acknowledged." >&2
    echo "Run the 'canary' phase first, confirm it PASSED, then re-run as:" >&2
    echo "  CANARY_PASSED=yes ./scripts/devnet-deploy.sh setup" >&2
    exit 3
  fi
  echo "== SETUP (>>> SPENDS ~4.34 SOL <<<): score_entry + reveal_top3 comp-defs =="
  echo "Assumes canary already created GameConfig + breed. Registers the remaining two."
  echo "Ctrl-C to abort. Sleeping 5s..."; sleep 5
  ANCHOR_PROVIDER_URL="$HELIUS_RPC_URL" \
  ANCHOR_WALLET="$DEVNET_WALLET" \
  ARCIUM_CLUSTER_OFFSET="$CLUSTER_OFFSET" \
    npx mocha --no-config --timeout 1800000 scripts/devnet-setup.ts
  echo "SETUP done. Now run: ./scripts/devnet-verify.sh"
}

case "${1:-}" in
  preflight) phase_preflight ;;
  build)     phase_build ;;
  deploy)    phase_deploy ;;
  canary)    phase_canary ;;
  setup)     phase_setup ;;
  *) echo "usage: $0 {preflight|build|deploy|canary|setup}  (one phase at a time)"
     echo "       setup requires: CANARY_PASSED=yes (after a passing canary)"; exit 2 ;;
esac
