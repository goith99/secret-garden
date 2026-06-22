# Secret Garden Protocol

On-chain foundation for a Web3 browser game, built with Anchor. **Stages 1–4B of 5.**

- **Stage 1** — game config, player profiles, starter-flower claiming.
- **Stage 2** — flower ownership status (`Active` → `Submitted`) and the daily
  competition-round lifecycle (open / submit / close / finalize).
- **Stage 3A/3B** — the encrypted **breeding** circuit (Arcium/MPC) + its
  `start_breeding` queue, resolution callback, and permissionless cancel.
- **Stage 4A/4B** — public round **target traits** and two encrypted **scoring** circuits
  (`score_entry`, `reveal_top3`); 4B closes three integrity gaps and ships the real
  callbacks that persist per-entry scores and finalize the top-3 winners.

Stage 5 features are **not** present here.

## Toolchain

Pinned versions (do not upgrade within this stage):

| Tool        | Version            |
| ----------- | ------------------ |
| arcium      | 0.10.4             |
| anchor-cli  | 1.0.2              |
| solana-cli  | 3.1.10 (Agave)     |
| rustc       | 1.95.0             |
| node        | v22                |
| yarn        | 4.15.0             |

Program ID: `7eMfGCkXavfZeVrwRo3ZH63C7H6mZ6n1HZKJwGkZBddo` (freshly generated for this
project; keypair lives in `target/deploy/secret_garden-keypair.json`, which is
git-ignored).

> Note: this ID changed once pre-deployment. The original git-ignored keypair was
> wiped by `arcium clean` and a subsequent build silently regenerated a new one. The
> program was never deployed to any cluster under either ID, so the change has zero
> on-chain impact.

## Program surface

### Accounts

- **GameConfig** — singleton, seeds `[b"config"]`.
- **PlayerProfile** — one per wallet, seeds `[b"profile", owner]`.
- **FlowerRecord** — one per flower, seeds `[b"flower", owner, flower_index_le]`.
  Stage 1 stores no genome/ciphertext; `genome_status` (0 = Starter, 1 = Encrypted)
  exists so Stage 3 can `realloc` and attach an encrypted genome without breaking
  client reload logic.

### Instructions

- **initialize_config** — creates `GameConfig` once (`paused = false`,
  `current_round = 0`, `starter_count = 6`, `version = 1`).
- **create_profile** — creates the caller's `PlayerProfile` (counters zeroed,
  `created_at` from the on-chain clock). Rejected while paused.
- **claim_starters** — mints all six starter flowers in **one transaction = one wallet
  approval** (10 accounts total, well within transaction limits), then sets
  `starter_claimed = true` and `total_flowers = 6`.

The six starter species (rarity + revealed-trait bitmask) are a compile-time `SPECIES`
table in `programs/secret-garden/src/constants.rs`; they are not stored on-chain.

### Stage 2 — competition rounds

Accounts:

- **CompetitionRound** — one per round, seeds `[b"round", round_id_le]`. Lifecycle
  `status`: `0 = Open → 1 = Closed → 2 = Finalized`.
- **CompetitionEntry** — one per (round, player), seeds `[b"entry", round, player]`.
  Its PDA uniqueness is the duplicate-submission guard.

Instructions:

- **open_round** — authority only; opens round `current_round + 1`. Requires the
  previous round (if any) to be `Finalized`. `end_time = start_time + 24h`,
  `max_participants = 16`.
- **submit_entry** — player submits one owned `Active` flower into an `Open` round
  before `end_time` while `participant_count < max_participants`; the flower becomes
  `Submitted` and the counters advance.
- **close_round** — round operator only; `Open → Closed`. No time check (early or late
  close is an intentional manual override).
- **finalize_round** — round operator only; `Closed → Finalized`. No scoring in Stage 2.

### Stage 3A — encrypted breeding (Arcium)

The `breed` circuit (`encrypted-ixs/src/lib.rs`) decrypts both parents' genomes in MPC
(or derives a Starter's genome from its public species id), combines them per-gene under
the player's private `Environment` with `ArcisRNG` randomness, and returns the offspring
`Enc<Mxe, Genome>` — the plaintext genome is never revealed.

Accounts / fields:

- **Experiment** — one per breeding run, seeds
  `[b"experiment", owner, total_experiments_le]`. Stage 3A only creates `status = Queued`.
- **PlayerProfile** gains `active_experiment_count` and `total_experiments` (the
  experiment-PDA nonce).
- **FlowerRecord** gains `genome_commitment [32]`, `encrypted_genome [320]`,
  `encryption_metadata [16]` (sizes measured from the circuit — see Design notes).

Instructions:

- **init_breeding_comp_def** — authority only; registers the `breed` computation
  definition (`init_computation_def`).
- **start_breeding** — one wallet approval: locks two owned `Active` parents
  (`→ Locked`), **pre-creates the offspring** flower (Locked, public metadata only),
  records a `Queued` Experiment, advances the profile counters, and queues the MPC
  computation registering the callback's writable accounts.
- **realloc_flower_genome** — Anchor `realloc` constraint demonstration / forward-compat
  migration (idempotent; flowers are already created full-size).

### Stage 3B — breeding resolution (Arcium)

- **breed_callback** — invoked by the Arcium cluster. On success: writes the offspring's
  `encrypted_genome` / `encryption_metadata` and a SHA-256 `genome_commitment`, flips it
  `Active`, unlocks both parents, and Completes the experiment. On failure: unlocks the
  parents and marks the experiment Failed (offspring stays Locked). Idempotent via
  `experiment.callback_processed`.
- **cancel_expired_experiment** — permissionless: after `EXPERIMENT_TIMEOUT_SECONDS`
  (600), anyone can expire a stuck Queued/Processing experiment to unlock the player's
  parents (sets `callback_processed = true` so a late callback no-ops).
- **PlayerProfile** also gains `next_flower_index` (the monotonic `u32` flower-PDA nonce;
  `total_flowers` is `u16` and can't be cast inside a PDA seed without breaking the IDL
  builder). Offspring get `visual_species_id = 255` (hybrid), `generation = max(parents)
  + 1`, and `genome_status = Encrypted`.

> **Arcium callbacks cannot create accounts** (no payer signer in the callback CPI), so
> the offspring is pre-created in `start_breeding` and the callback only fills its genome
> — the canonical "create in queue, write in callback" pattern.

### Stage 4A — scoring (Arcium, queue-only)

Public target traits + two encrypted scoring circuits. Build-only milestone (queue
instructions + stub callbacks); persistence is Stage 4B.

- **Trait table** (`constants::TRAIT_TABLE`, 10 entries): a stable `id` + UI `name` per
  trait; each trait's CONDITION over `Genome` fields is defined canonically in the
  `score_entry` circuit (the genome is encrypted, so conditions only run in MPC) and
  mirrored in a comment beside each table entry.
- **open_round (extended)** now also generates the round's **public** target traits:
  `entropy = SHA-256(slot ‖ timestamp ‖ round_id)` → `target_trait_count` (2–4) + that
  many distinct trait ids via a partial Fisher-Yates. The entropy is weakly predictable,
  which is fine — traits are intentionally public (strategizing around them is the game).
  `CompetitionRound` gains `target_traits[4]`, `target_trait_count`, `top1/2/3`,
  `scoring_revealed`, `scored_count` (all appended; Stage 2 offsets unchanged).
- **score_entry circuit** → `Enc<Mxe, u8>`: match% = `(matched / count) * 100` over the
  active target traits, plus `+5 per generation above 1`, capped at 100. The score stays
  **encrypted**.
- **reveal_top3 circuit** → plaintext `(idx,score)×3`: takes one `Enc<Mxe,[u8;16]>` of
  scores + a plaintext `entry_indices[16]` + `participant_count`; ranks each slot by how
  many beat it (strict score, ties broken by lower index), then reveals only the rank
  0/1/2 winners. All other scores stay encrypted forever.
- **Instructions**: `init_score_entry_comp_def` + `init_reveal_top3_comp_def` (two,
  because the Arcium init macro binds one accounts struct to one circuit — a single
  `init_scoring_comp_defs` is not possible), `queue_score_entry` (authority; round must be
  Closed), `queue_reveal_top3` (authority; round Closed + fully scored). In Stage 4A
  callbacks were verify-and-emit stubs; Stage 4B replaces them (below).

### Stage 4B — scoring integrity + resolution (Arcium)

Stage 4B closes three integrity gaps and ships the real callbacks. `CompetitionEntry`
gains `encrypted_score [32]`, `score_nonce [16]`, `scored`, `score_error_code` (appended;
Stage 2 offsets unchanged).

- **GAP 1 — no double-counting.** `queue_score_entry` requires `entry.scored == false`,
  and `score_entry_callback` sets `scored = true` and bumps `round.scored_count`
  idempotently (if `scored` is already true it no-ops). So even a double-queue before the
  first callback lands can't double-count.
- **GAP 2 — scores read from chain, never caller-supplied.** `queue_reveal_top3` now
  takes **only** `computation_offset`; the round's entries are passed as
  `remaining_accounts`, validated (`entry.round == round`, `entry.scored`), and each
  score ciphertext is read in-place via `ArgBuilder::account()` (the `reveal_top3` circuit
  changed to 16 separate `Enc<Mxe,u8>` to support this). Padding slots reuse a real
  entry's score (masked to 0 in-circuit), so a caller cannot inject fabricated scores.
- **GAP 3 — no fabricated winners.** `reveal_top3_callback` writes `top_k` only when
  `participant_count >= k`; the circuit returns winner SLOT indices, the callback maps
  them to entry pubkeys, and unfilled slots stay `Pubkey::default()`. The callback is
  idempotent on `scoring_revealed`.

## Build & test

```bash
arcium build      # compiles the breed circuit + the Anchor program + IDL
cargo check --all
yarn typecheck    # strict TS, no `any`

# Fast, deterministic in-process suite (Stages 1/2 + Stage 3B cancel logic):
yarn test                                            # solana-bankrun, no cluster

# Live MPC suite (real Arcium localnet, slow — Docker required):
arcium test                                          # runs tests/scoring.ts (Stage 4B)
yarn test:breeding                                   # Stage 3B breeding, live cluster
```

`yarn test` uses [`solana-bankrun`](https://github.com/kevinheavey/solana-bankrun) — an
in-process Solana validator — so it is deterministic and needs no cluster. It cannot
simulate the MPC round-trip, so the live lifecycles run against a 2-node Arcium cluster:
scoring (`tests/scoring.ts`, the default `arcium test` script) and breeding
(`tests/breeding.ts`, `yarn test:breeding`). The timeout-driven
`cancel_expired_experiment` is tested in bankrun (`tests/cancel.ts`), which can pin the
clock.

> The breeding flow (`start_breeding` + callback) needs a running Arcium cluster and is
> exercised in **Stage 3B** via `arcium test`; Stage 3A is a build-only milestone.
> This project does **not** deploy anywhere. Do not run any devnet deploy command.

## Design notes

- **Testing the pause guard.** Stage 1 intentionally exposes no admin "set paused"
  instruction (only the three required instructions exist), so the tests seed a paused
  `GameConfig` directly into the in-process validator via `setAccount`. This exercises
  the `GamePaused` guard without inventing an out-of-scope instruction.
- **Double-claim protection.** A second `claim_starters` is rejected two ways: the
  `starter_claimed` constraint, and the fact that the six flower PDAs already exist.
  Anchor runs account `init` before custom `constraint` checks, so a real re-claim
  trips the flower-PDA collision first; the explicit `StartersAlreadyClaimed` error is
  still verified directly (see the "guard when reached" test).
- **Optional previous round.** `open_round` takes `previous_round` as an optional
  account (`None` for the first round). For later rounds the handler requires it to be
  the `Finalized` round at `current_round` (verified via its immutable `round_id`).
- **Testing `RoundFull` / time / status guards.** Rather than performing 16 real
  submissions, the `RoundFull` test raises `participant_count` to `max_participants`
  with `setAccount`; the deadline test pins the clock past `end_time`; the
  not-owned / not-active tests patch the flower account in place. Each Stage 2 test
  bootstraps a fresh in-process validator, so cases stay isolated and deterministic.

### Stage 3A (Arcium breeding)

- **Genome layout, measured.** `breed` returns `Enc<Mxe, Genome>`; `Genome` is 10 `u8`
  fields, and Arcis encrypts each scalar as one 255-bit BN254 field element serialized
  to 32 bytes. Measured from `build/breed.ts` after `arcium build`: **10 ciphertexts =
  320 bytes** (`encrypted_genome`) + a **16-byte** u128 nonce (`encryption_metadata`);
  `genome_commitment` is a separate 32-byte digest. The 0..=255 logical range uses only
  the low byte of each field element — that headroom is the encoding "padding".
- **One-of-two parent shapes.** Arcis has no sum types, so each parent passes both a
  public `kind`/`species` and an `Enc<Mxe, Genome>` (the stored ciphertext, referenced
  in-place via `ArgBuilder::account(...)`; zeroed and ignored for Starters). The circuit
  selects on the public `kind`.
- **Environment combined.** The three private inputs are one `Enc<Shared, Environment>`
  (single pubkey + nonce + three ciphertexts) instead of three `Enc<Shared, u8>`, so
  there is exactly one nonce to manage — avoiding nonce-reuse footguns.
- **Stack / boxing.** Adding the genome fields makes `FlowerRecord` ~528 bytes, which
  overflowed the 4 KB SBF stack in `claim_starters` (six inits) and `start_breeding`.
  The large game accounts are `Box`ed (alongside the v0.10 boxing of `MXEAccount` /
  `Cluster` / `ComputationDefinitionAccount`) to fix it — a build-forced, logic-
  preserving change.
- **`realloc` reality.** Because `Account<FlowerRecord>` deserializes the full layout,
  flowers must be created full-size (`claim_starters` already uses `8 + INIT_SPACE`), so
  no runtime realloc is actually needed. `realloc_flower_genome` still provides Anchor's
  `realloc` constraint pattern as an idempotent forward-compat path.
- **Callback is a Stage 3A stub** — it only verifies the signed output and emits an
  event. Stage 3B persists the genome to the offspring flower and resolves the
  experiment.

### Stage 3B (Arcium breeding resolution)

- **Priority Zero — the `account()` read is verified by the MPC's MAC.** The MPC
  MAC-verifies every `Enc<Mxe>` input, so a *successful* encrypted-parent breeding
  cryptographically proves that `ArgBuilder::account(flower, 192, 320)` delivered the
  correct stored ciphertext — a wrong offset would corrupt the bytes and abort the
  computation (`AbortReason::InvalidMAC`). The offset `192` was also re-derived from the
  real `state.rs` layout (8 discriminator + 152 original fields + 32 `genome_commitment`)
  and is **correct** (`FLOWER_ENCRYPTED_GENOME_OFFSET`).
- **Offspring pre-creation.** Arcium callbacks cannot `init` accounts (no payer signer),
  so `start_breeding` pre-creates the offspring (public metadata, Locked) and the callback
  only writes the genome and flips it Active. A failed/expired breeding leaves the
  offspring Locked (a dead, rent-funded account) — an accepted cost; a future `close`
  could reclaim the rent.
- **Failure reporting is coarse by design.** `verify_output` collapses all failures to
  `AbortedComputation`; the granular `ExecutionFailure` reason is an Arcium *event*, not
  passed to the callback (`SignedComputationOutputs::Failure` carries only a BLS sig). The
  callback therefore records a single sentinel `error_code`.
- **Cancel/late-callback safety.** `cancel_expired_experiment` sets
  `callback_processed = true`, so a computation that finishes after expiry no-ops in the
  callback (no double `active_experiment_count` decrement).
- **Tests.** `tests/breeding.ts` (live, `arcium test`) covers the happy path, the
  encrypted-parent Priority Zero case, and parallel experiments; `tests/cancel.ts`
  (bankrun, clock-pinned) covers the cancel lifecycle. Duplicate-callback and
  forced-circuit-failure are not triggered live (a real duplicate/abort can't be safely
  injected from the cluster); their guards are covered by code review + the cancel/idempotency
  path. On this WSL2 host the Arcium localnet's MXE keygen is slow, so
  `Arcium.toml`'s `localnet_timeout_secs` is raised to 300 and the test polls ~4 min for
  the MXE key.

### Stage 4A (Arcium scoring)

- **Arcis capability check (verified against the installed crate + `arcium build`).** A
  docs page reportedly lists `match` as unsupported, but the installed
  `arcis-0.10.x` `Rust-Support.md` lists it as *Partial Support* and `arcium build`
  compiles it (Stage 3A already relied on it). For Stage 4A I also confirmed, against the
  crate and a real build: `bool → integer` casts, `integer → integer` casts, array
  indexing with loop vars, nested `for` loops, `.reveal()`, multi-value tuple outputs, and
  `Enc<Mxe, [u8; N]>` inputs/outputs all work. **Finding: trust the installed crate +
  compiler over the "Operations" doc page — `match` is supported in 0.10.4.**
- **reveal_top3 over variable participant counts.** The circuit always operates over a
  fixed 16-slot array; slots `>= participant_count` are masked to score 0 (lowest), so
  padding never outranks a real entry. Top-3 selection uses a rank-by-pairwise-comparison
  (each slot counts how many beat it; ties broken by lower index → unique ranks), which
  avoids secret-indexed array writes. It compiled (447M ACUs) — no plaintext-score
  fallback was needed, so the hidden-score-until-reveal property holds.
- **Two init instructions, not one.** `init_computation_def` takes a macro-bound
  `InitCompDefAccs` struct (one circuit per struct), so registering two comp defs requires
  two instructions — `init_scoring_comp_defs` as a single instruction is not expressible.
- **Scoring is queue-only in 4A.** `queue_reveal_top3` takes the 16 scores as instruction
  data (the per-entry score storage is a 4B decision); its `scored_count == participant_count`
  gate is inert until 4B writes `scored_count`. `queue_score_entry` does not yet enforce
  "once per entry" (needs a per-entry flag, which can't be added to `CompetitionEntry`
  under this stage's additive-to-`CompetitionRound`-only rule). Both are documented open
  questions for 4B.

### Stage 4B (scoring integrity)

- **GAP 1 race analysis.** The `!entry.scored` queue check is the first line of defence;
  the structural guarantee is the callback's `scored` idempotency. If two
  `queue_score_entry` calls slipped through before either callback landed, two
  computations would run, but the first callback to land sets `scored = true` and bumps
  `scored_count`; the second sees `scored == true` and no-ops. So `scored_count` is never
  double-counted — at most a redundant computation is wasted. No extra "queued" flag is
  needed (same pattern as `breed_callback`). Caveat: a computation that is queued but
  never calls back leaves `scored = false` (re-queueable) — there is no `cancel` for
  scoring yet (open question for Stage 5).
- **GAP 2 — why account-reading is safe.** The MPC MAC-verifies every `Enc<Mxe>` input,
  so a tampered ciphertext aborts the computation. Reading each score from its entry
  account (validated `entry.round == round` + `entry.scored`) means the only scores that
  reach the circuit are the ones `score_entry` actually produced. The strongest proof is
  type-level: `queue_reveal_top3` no longer has any score parameter (a regression test
  asserts its arg list is just `computation_offset`).
- **GAP 3 — default-pubkey is unambiguous.** A real entry is a program PDA, so it can
  never equal the all-zero `Pubkey::default()`; an unfilled `top_k` is therefore a
  distinct, machine-checkable "no k-th winner". The circuit always returns 3 slots (fixed
  shape); the on-chain callback drops slots beyond `participant_count`.
- **Tie-break.** Equal scores are broken by lower entry slot (the circuit's
  `(s[j]==s[i]) && (j<i)` term gives unique ranks). With random offspring genomes a tie is
  not deterministically reproducible in a live test, so this is verified by the circuit
  logic + compilation; the live tests verify the overall ordering (revealed scores
  descending, distinct real winners).
- **Tests.** `tests/scoring.ts` (live, `arcium test`) covers the full lifecycle, GAP 1
  (re-score fails), GAP 2 (type-level no-score-args), and GAP 3 (1- and 2-participant
  rounds leave top2/top3 / top3 as default). Scoreable flowers are bred offspring (real
  encrypted genomes), so the test also exercises the Stage 3B breeding path end-to-end.
  Genomes/scores are random + MXE-encrypted, so the tests assert structural correctness,
  not exact score values. `arcium clean` before each localnet run (stale keygen state
  otherwise fails MXE keygen).
