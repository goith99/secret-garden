# Secret Garden — Devnet Deployment (preparation)

Program ID: `7eMfGCkXavfZeVrwRo3ZH63C7H6mZ6n1HZKJwGkZBddo`
Status: **prepared, NOT deployed.** No devnet transaction has been sent. This document +
`scripts/devnet-deploy.sh`, `scripts/devnet-upload-circuit.ts` (circuit comp-def
registration + upload), `scripts/devnet-verify.sh`, and `scripts/operator.ts` (round /
game-state operations) are everything needed to deploy and run manually.

All Arcium commands/flags below were verified against docs.arcium.com for v0.10.x.

---

## 1. Toolchain & environment (audited)

| Tool | Required | Installed | Note |
|------|----------|-----------|------|
| arcium | 0.10.4 | 0.10.4 | ✅ |
| anchor-cli | 1.0.2 | 1.0.2 | ✅ |
| solana-cli | 3.1.10 | 3.1.10 | ✅ |
| rustc | (task said 1.95.0) | **1.89.0** | ⚠️ `rust-toolchain.toml` pins **1.89.0**; that is what builds. Task spec of 1.95.0 is inaccurate — no action needed, build is clean on 1.89.0. |
| node | v22 | v22.22.3 | ✅ (strips TS types natively → mocha runs `.ts`, no ts-node) |
| yarn | 4.15.0 | 4.15.0 | ✅ |

- **Build:** `arcium build` clean (exit 0); program ID stable at `7eMfGCk…`, no keypair regeneration.
- **Regression (bankrun):** `yarn test` → **50 passing**.
- **Live MPC suites** (`yarn test:breeding`, `arcium test`/`tests/scoring.ts`): require the
  local Arcium docker cluster and are slow/keygen-flaky on this host (documented). **Not
  re-run here** — recommended as a manual gate before deploy, not a blocker for prep.
- **RPC default is PUBLIC devnet** (`solana config get` → `api.devnet.solana.com`). Every
  deploy/init/verify command forces `$HELIUS_RPC_URL` instead. Read-only checks may use public devnet.

### Devnet RC compatibility (checked, read-only)
- Devnet cluster version: **4.1.0-rc.1** (release candidate; consistent with the 2026-06-19 devnet restart).
- solana-cli 3.1.10 queried devnet fine (`cluster-version`, `block-height`, `balance` all succeeded)
  → **JSON-RPC compatibility is OK for reads.** Deploy is a write path; the RPC envelope is
  identical, so the residual risk is **not** RPC but validator-side (below).

### ⚠️ Risk flags to validate BEFORE committing to full setup spend
1. **sBPF version vs devnet (HIGH).** Prior sessions hit devnet rejecting certain sBPF
   versions for Arcium-built programs ("keep the pinned stack; it's an Arcium-release issue").
   Devnet is now on a *newer* RC validator, so re-confirm the program loads. Mitigation: the
   `deploy` phase is isolated — if `arcium deploy` fails at program-load, no comp-def spend happens yet.
2. **`Enc<Mxe>` on shared cluster 456 (HIGH — gated by the canary phase).** A prior note
   recorded cluster 456 aborting `Enc<Mxe>`-input computations. All three circuits take
   `Enc<Mxe>` as input and re-read persisted `Enc<Mxe>` via `ArgBuilder::account()`
   (breed reads parent genomes; score_entry reads the genome; reveal_top3 reads scores).
   This is exactly the at-risk shape, so it is verified BY A DEDICATED `canary` PHASE
   **before** the expensive comp-def spend — see §4. The prior note's "unaffected"
   conclusion is from an earlier session; treat as "verify live," not settled fact.
3. **RC validator instability.** A post-restart `-rc.1` validator can be transiently flaky;
   `arcium deploy --resume` covers interrupted deploys.

---

## 2. Cluster offset decision

**Use `--cluster-offset 456`** (set via `ARCIUM_CLUSTER_OFFSET=456` for the TS phases).

Reasoning — and a correction to the "needs a NEW isolated offset" premise:
- On devnet the cluster offset selects **which shared ARX node cluster** runs your MPC. Per
  docs, **456 is the canonical public devnet cluster** — it is *not* a per-app value you mint.
- Isolation from privacy-dex / shade-intent-solver / nullref is **automatic and already
  guaranteed by the distinct program ID** `7eMfGCk…`: the MXE account, the 3 comp-def PDAs,
  and every per-computation account derive from the program ID, so two apps on cluster 456
  never share state. Per-computation `computation_offset` values are random `u64`s
  (`randomBytes(8)`), isolated per call.
- ⚠️ **Verify 456 is still the live devnet cluster post-restart** before deploy (the
  `preflight` phase prints cluster-version; if Arcium reassigned devnet's offset after
  2026-06-19, update `CLUSTER_OFFSET` in `scripts/devnet-deploy.sh` and the env in `*-verify.sh`).
- Where it's set: env var `ARCIUM_CLUSTER_OFFSET=456` (used by `arcium.getArciumEnv()` in the
  TS phases) and `--cluster-offset 456` on `arcium deploy`. Optionally mirror into
  `Arcium.toml` `[clusters.devnet] offset = 456` for `arcium test --cluster devnet`.

---

## 3. Cost estimate (real devnet SOL)

Rent figures are exact from `solana rent <bytes>`; account sizes from Anchor `#[derive(InitSpace)] + 8`.

### (a) One-time setup — split across 3 spend phases so the Enc<Mxe> risk is gated cheaply

**Phase `deploy` — program + MXE**
| Item | Size | Cost (SOL) |
|------|------|-----------|
| Program binary rent (programdata, exact-fit) | 823 045 B | **5.729** |
| ⤷ if `arcium deploy` reserves 2× upgrade headroom | 1 646 045 B | up to 11.457 |
| ⤷ transient deploy buffer (reclaimed after deploy) | ~823 KB | ~5.73 peak, refunded |
| MXE account + LUT | small | ~0.02 (est.) |
| **deploy subtotal** | | **≈ 5.7 – 11.5 SOL** |

**Phase `canary` — GameConfig + breed ONLY (the Enc<Mxe> go/no-go)**
| Item | Size | Cost (SOL) |
|------|------|-----------|
| GameConfig PDA | 52 B | 0.00125 |
| breed comp-def circuit (on-chain) | 438 008 B | 3.049 |
| player profile + 6 starters + experiments (test rents) | — | ~0.05 |
| breed chunk-upload + MPC fees (~6 breeds) | — | ~0.01 + MPC |
| **canary subtotal** | | **≈ 3.1 SOL** ← max at-risk before go/no-go |

**Phase `setup` — remaining circuits, ONLY after canary passes**
| Item | Size | Cost (SOL) |
|------|------|-----------|
| score_entry comp-def circuit (on-chain) | 100 522 B | 0.701 |
| reveal_top3 comp-def circuit (on-chain) | 523 413 B | 3.644 |
| chunk-upload tx fees | — | ~0.007 |
| **setup subtotal** | | **≈ 4.35 SOL** |

| **One-time total (exact-fit program)** | **≈ 13.2 SOL** |
|------|------|
| **One-time total (2× headroom program)** | **≈ 19.0 SOL** |

> Key property of this ordering: if Enc<Mxe> is broken on 456, you discover it after
> spending only `deploy` (~5.7–11.5 SOL, recoverable via `solana program close` / `arcium
> close-mxe`) + `canary` (~3.1 SOL, recoverable via deactivate/close) — **never** the
> ~4.35 SOL of score_entry+reveal_top3 circuits, which you would not yet have uploaded.

### (b) Per-player onboarding (player pays their own rent)
| Item | Size | Cost (SOL) |
|------|------|-----------|
| PlayerProfile | 68 B | 0.00136 |
| 6 × starter FlowerRecord | 528 B ea | 0.02740 |
| **Per player** | | **≈ 0.029 SOL** (rent, recoverable) |

### (c) Per-breeding
| Item | Size | Cost (SOL) |
|------|------|-----------|
| Experiment | 165 B | 0.00204 |
| Offspring FlowerRecord (callback) | 528 B | 0.00457 |
| Arcium computation fee + tx fees | — | ⚠️ see ambiguity #3 |
| **Per breeding** | | **≈ 0.0066 SOL rent + 1 MPC compute fee** |

### (d) Per-round (≤16 participants)
| Item | Size | Cost (SOL) |
|------|------|-----------|
| CompetitionRound | 174 B | 0.00210 |
| up to 16 × CompetitionEntry (players pay) | 174 B ea | ≤0.0336 |
| 16 × score_entry + 1 × reveal_top3 MPC fees | — | ⚠️ see ambiguity #3 |
| **Per round** | | **≈ 0.036 SOL rent + 17 MPC compute fees** |

### Wallet sufficiency
Operator wallet `BDYhe…273w` = **61.7238 SOL** (confirmed read-only). One-time worst case
≈ 19 SOL + transient ~5.7 SOL buffer ≈ **~25 SOL peak**, leaving ~37 SOL for operations.
**✅ Comfortably sufficient (≈2.5× the worst-case setup).**

### Genuinely ambiguous (real funds — do not treat as fact)
1. **Program rent 5.73 vs 11.46 SOL** — depends on whether `arcium deploy` passes a 2×
   `--max-len`. Watch the actual programdata size after deploy; budget for 11.5 to be safe.
2. **MXE/LUT exact rent** (~0.03 SOL est.) — small, not separately quoted by docs.
3. **Arcium per-computation cluster fee on devnet** — not pinned from docs offline. Affects
   (c)/(d) operational cost, not one-time setup. Confirm empirically with the first breed.

---

## 4. Manual deployment checklist

> Run phases one at a time; read output before the next. Nothing auto-runs. The
> `deploy → canary → [you review] → setup` order front-loads the Enc<Mxe> risk.

```
export HELIUS_RPC_URL="https://devnet.helius-rpc.com/?api-key=<KEY>"   # never commit this
# DEVNET_WALLET = the GAME AUTHORITY. The canary reuses tests/breeding.ts, which
# hardcodes ~/.config/solana/id.json as authority/player, so use that SAME funded
# keypair for deploy + canary + setup (consistent GameConfig.authority). Your 61.7 SOL
# is currently in devnet-wallet.json — fund/move ~25 SOL into id.json, or point id.json
# at your operator keypair, before starting.
export DEVNET_WALLET="$HOME/.config/solana/id.json"
chmod +x scripts/devnet-deploy.sh scripts/devnet-verify.sh   # once
```

1. `./scripts/devnet-deploy.sh preflight` — read-only. Confirm id = `7eMfGCk…`, devnet
   4.1.0-rc.1, `$DEVNET_WALLET` balance ≥ ~25 SOL, 3 `.arcis` present. **Spends nothing.**
2. `./scripts/devnet-deploy.sh build` — local `arcium build`; confirm id did NOT regenerate. **Spends nothing.**
3. `./scripts/devnet-deploy.sh deploy` — **SPENDS ~6–11.5 SOL.** Program + MXE on cluster 456.
   If it dies mid-way → `arcium deploy --resume …` (same flags).
4. `./scripts/devnet-deploy.sh canary` — **SPENDS ~3.1 SOL.** Inits GameConfig + registers/
   uploads **breed only**, then runs the breeding round-trips. This is the Enc<Mxe> gate.
5. **>> YOU review the canary result. <<** PASS = breeding tests all green, especially
   "(2) Encrypted parent reads stored ciphertext via account()". FAIL = abort/no-finalize/
   wrong result → **STOP**, do not run setup, go to §5 "If the canary fails".
6. `CANARY_PASSED=yes ./scripts/devnet-deploy.sh setup` — **SPENDS ~4.35 SOL.** Registers
   score_entry + reveal_top3 (the script refuses without `CANARY_PASSED=yes`).
7. `./scripts/devnet-verify.sh` — read-only. Program executable, GameConfig (paused=false,
   round=0), all 3 comp defs registered.

---

## 5. Rollback / recovery (verified against docs.arcium.com)

This project has **no prior devnet-deploy experience** — flags below are from current docs, not habit.

### If the canary FAILS (Enc<Mxe> genuinely broken on cluster 456)
A canary fail = the breeding computation **aborts**, **never finalizes**, or returns an
offspring whose `encrypted_genome` stays all-zero / test "(2)" fails. That means the exact
`Enc<Mxe>` read/write the whole protocol relies on does not work on the only public devnet
cluster. **Do not run `setup`.** Options, in order of preference:
1. **Pause and escalate to Arcium** (Discord `#dev-support` / support) with the failing
   computation signature + cluster offset 456. This was previously an *Arcium-release-level*
   issue, not something fixable in this repo — confirm current status before spending more.
2. **Wait for an Arcium fix / cluster update.** The program + breed comp-def already on devnet
   stay valid; re-run the canary after the cluster is patched (no redeploy needed).
3. **Try an alternate cluster offset** *only if* Arcium confirms another viable devnet cluster
   exists (there may be just the one public cluster). If so, `arcium close-mxe` on 456, then
   redeploy with the new `--cluster-offset`. Do NOT guess an offset — confirm it with Arcium.
4. **Reclaim rent if abandoning devnet:** `arcium close-mxe` (MXE + breed comp-def) +
   `solana program close` (program). See teardown below.
Do not attempt a code workaround here — `Enc<Mxe>` persistence is structural to genome/score
storage; switching to `Enc<Shared>` would change the trust model and is out of scope for deploy.

**Retryable vs not**
- **`deploy` phase** is the most retryable: `arcium deploy --resume` continues an interrupted
  program upload/MXE init using the same `--program-keypair`/offset. A half-uploaded program
  buffer is recoverable (resume) or closable (`solana program close --buffers`).
- **`canary` phase** runs tests/breeding.ts, which inits GameConfig + registers breed. If it
  dies AFTER GameConfig/breed were created but before tests finish, those accounts persist;
  re-running breeding.ts will fail on `initializeConfig`/`initBreedingCompDef` "already in use".
  To re-test breeding without re-registering, run a breed manually or temporarily skip the
  `before()` registration — but the usual case is: canary either passes or reveals the §5 fault.
- **`setup` phase** is per-account idempotent-by-failure: each `initCompDef` (score_entry,
  reveal_top3) **fails if the account already exists**. After a partial failure, re-run
  `scripts/devnet-upload-circuit.ts` for only the circuit that didn't finish (a circuit whose
  comp-def already exists is skipped). `uploadCircuit` can be re-run for a circuit whose upload
  didn't finish.

**What partial failure looks like**
- Program deployed but MXE missing → `arcium deploy --skip-deploy …` initializes the MXE only.
- MXE up but program not (rare) → `arcium deploy --skip-init …` deploys the program only.
- GameConfig created but comp defs missing → re-run `setup` with the config `it()` skipped.
- Comp def account created but circuit not uploaded → re-run only that `uploadCircuit`
  (the `initCompDef` for it will now fail "already in use" — that's expected; skip it).

**Reclaiming rent (teardown)** — two-step, per docs:
1. `arcium deactivate-computation-definition -o <offset> -p <programId> -k <wallet> --rpc-url $HELIUS_RPC_URL`
2. after ~72 s: `arcium close-computation-definition -o <offset> -p <programId> -c <clusterOffset> -k <wallet> --rpc-url $HELIUS_RPC_URL`
- `arcium close-mxe -p <programId> -k <wallet> --rpc-url $HELIUS_RPC_URL` closes the MXE and all
  reserved comp defs atomically (recovers their rent in one shot).
- Program rent: `solana program close <PROGRAM_ID> --url $HELIUS_RPC_URL` (irreversible; only if abandoning the address).

**Deploy flags reference** (`arcium deploy`, v0.10.x): `--cluster-offset`, `--recovery-set-size`
(min 4), `--program-keypair`, `--keypair-path`, `--rpc-url`, `--skip-deploy`, `--skip-init`, `--resume`.
