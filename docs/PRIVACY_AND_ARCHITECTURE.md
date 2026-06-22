# Secret Garden Protocol — Privacy & Architecture (accuracy pass)

A precise, honest statement of what is **actually** private vs. public in the CURRENT
shipped code (Stage 5C), verified against `programs/secret-garden/src/state.rs`,
`encrypted-ixs/src/lib.rs`, and `lib.rs` — not the original design plan.

The protocol is an **MXE** (Arcium MPC eXecution Environment): an Anchor program + three
Arcis circuits (`breed`, `score_entry`, `reveal_top3`). Encryption uses `Enc<Owner, T>`
where `Owner` decides who can ever decrypt: `Mxe` = only inside MPC (never as plaintext to
any wallet), `Shared` = sealed to one client's x25519 key. A `.reveal()` makes a value
public.

---

## 1. What is encrypted vs. public, by field

### Genuinely encrypted on-chain (opaque ciphertext)

| Where | Field(s) | Encryption | Who can decrypt |
|---|---|---|---|
| `FlowerRecord` | `encrypted_genome [320]` + `encryption_metadata [16]` | `Enc<Mxe, Genome>` (10 × `u8` genes → 10 × 32-byte BN254 ciphertexts + u128 nonce) | **Only the MXE, inside MPC.** Never exposed as plaintext on-chain, and NOT sealed to the player either (it is `Mxe`, not `Shared`). |
| `CompetitionEntry` | `encrypted_score [32]` + `score_nonce [16]` | `Enc<Mxe, u8>` | Only the MXE. Stays hidden until `reveal_top3` — and even then only the **top-3** scores are made public; every other entry's score stays encrypted forever. |
| (transient, never stored) | the player's breeding `Environment` (light/water/soil) | `Enc<Shared, Environment>` | The MXE (in MPC). Passed as ciphertext in `start_breeding`; not persisted to any account. |

> The genome's `genome_commitment [32]` IS public, but it is a SHA-256 hash of
> `(ciphertext ‖ nonce)` — it reveals nothing about the genes; it only lets anyone verify
> the stored ciphertext hasn't been swapped.

### Public on-chain — and always was, by design

All non-ciphertext fields are plaintext and world-readable (cite `state.rs`):

- **`FlowerRecord`:** `owner`, `flower_index`, `visual_species_id` (255 = hybrid),
  `generation`, `rarity`, `stability`, `revealed_trait_mask`, `parent_a`, `parent_b`,
  `genome_status`, `source_experiment`, `status` (Active/Locked/Submitted), `created_at`.
- **`CompetitionRound`:** `round_id`, `status`, `start_time`, `end_time`,
  `max_participants`, `participant_count`, `authority`, **`target_traits[4]` +
  `target_trait_count`** (public on purpose — strategizing around them is the game),
  `top1/top2/top3` (public winners after reveal), `scoring_revealed`, `scored_count`.
- **`CompetitionEntry`:** `round`, `player`, `flower_record`, `submitted_at`, `status`,
  `scored`, `score_error_code`, `score_queued`, `queued_at`.
- **`Experiment`:** `owner`, `parent_a`, `parent_b`, `computation_offset`, `status`,
  `result_flower`, `created_at`, `updated_at`, `error_code`, `callback_processed`.
- **`GameConfig`** and **`PlayerProfile`** — entirely public (config flags, counters).
- **Wallet addresses, timestamps, all lifecycle statuses** — public (ordinary Solana
  account data).

**Bottom line:** the ONLY private data is the genome genes and the per-entry scores
(both `Enc<Mxe>`), plus the transient breeding environment input (`Enc<Shared>`).
Everything else — including who bred what with what, when, and the round's target traits —
is and always was public.

---

## 2. Breeding fairness — what we can honestly claim

**Accurate claim: breeding outcomes are *provably fair* (MPC-computed, not predictable or
manipulable by the player).** Verified in `encrypted-ixs/src/lib.rs::breed`:

- Per-gene parent selection and mutation use `ArcisRNG::gen_uniform::<u8>()` **inside the
  MPC computation**. No single party — including the player — sees or controls the
  randomness, so a player cannot predict or grind a favorable outcome.
- Every `Enc<Mxe>` input is MAC-verified by the MPC, so tampering with a parent ciphertext
  aborts the computation rather than producing a forged child.
- The result is returned `Enc<Mxe, Genome>` and persisted with a SHA-256 commitment, so the
  stored child genome is tamper-evident.

**What we must NOT overclaim: this is not "fully private genetics."** Be precise:

- The genome **ciphertext** lives on-chain (it is not absent), and traits are selectively
  surfaced over time — `revealed_trait_mask` is public, and `score_entry` evaluates
  trait conditions over the genome (the score, not the genes, is revealed; the top-3 scores
  do become public).

- **`revealed_trait_mask` (Stage 3C — now genuinely populated, was always 0 before).** A
  public `u32` written by `breed_callback`, packed as four coarse visual classes (each
  `0..=4`): bits 0-7 petal, 8-15 color, 16-23 leaf, 24-31 stem. It exists purely so the
  frontend can render a distinct-looking hybrid. **What it reveals:** four coarse cosmetic
  class buckets — nothing more. **What it does NOT reveal:** the genome. The mask VALUE is
  computed inside the `breed` circuit from fresh MPC randomness (`ArcisRNG`), nudged only
  by the **public** parent species ids; the secret genome and the player's secret
  environment are deliberately **excluded** from it. That choice is the security point: if
  the mask were a deterministic public function of the encrypted genome, an observer
  collecting many masks from the same parents could statistically infer hidden genes — a
  side-channel. Because the mask's entropy is MPC-internal randomness and its only
  non-random input is already public, revealing it leaks nothing about the `Enc<Mxe>`
  genome. (It is `.reveal()`-ed plaintext, not `Enc<Mxe>`, because it is meant to be
  public — unlike the genome.)
- Because the genome is `Enc<Mxe>` (not `Enc<Shared>` to the owner), **even the player
  cannot decrypt their own raw genome** as plaintext; genes are only ever operated on
  inside MPC. So the right framing is "hidden, tamper-proof, provably-fair genetics," not
  "the player privately holds secret genes."

This matches the project's earlier confirmed positioning: emphasize **provable fairness /
non-manipulability**, not absolute genetic secrecy.

---

## 3. Stage 4B integrity guarantees (the three gap fixes)

What each fix actually guarantees, and by which mechanism (not just the gap name):

- **GAP 1 — no double-counting of scores.** `queue_score_entry` rejects an already-scored
  entry (`!entry.scored`), and `score_entry_callback` is **idempotent**: it sets
  `scored = true` and bumps `round.scored_count` only on the `!scored` path, so a duplicate
  or raced callback no-ops. *Mechanism: structural idempotency on a durable flag* — even if
  two computations are queued, `scored_count` moves exactly once. (Stage 5A added
  `score_queued` to also block a second concurrent queue; Stage 5B proved the exactly-once
  property holds across cancel/retry interleavings.)
- **GAP 2 — scores can't be fabricated by the caller.** `queue_reveal_top3` takes **only**
  `computation_offset` — it has *no score parameter at all* (type-level prevention; a
  regression test asserts the arg list). Each score ciphertext is read **in place from its
  own `CompetitionEntry` account** via `ArgBuilder::account()`, after validating
  `entry.round == round` and `entry.scored`. *Mechanism: account-sourced reads + MPC MAC
  verification* — a tampered `Enc<Mxe>` aborts the computation, so the only scores that
  reach the circuit are the ones `score_entry` actually produced. Padding slots reuse a
  real entry's score (masked to 0 in-circuit), so unused slots can't inject data either.
- **GAP 3 — no phantom winners.** `reveal_top3_callback` writes `top_k` **only when
  `participant_count >= k`**; the circuit returns winner SLOT indices, the callback maps
  them to entry pubkeys, and unfilled ranks stay `Pubkey::default()`. *Mechanism: a
  structural default-sentinel* — a real entry is a program PDA and can never equal the
  all-zero default, so "no k-th winner" is unambiguous and machine-checkable. The callback
  is idempotent on `scoring_revealed`.

---

## 4. Open verification items — NOT yet true / do not assume

Stated explicitly so nothing here is mistaken for proven:

- **No mainnet.** The program is not deployed to mainnet. It is also **not deployed to
  devnet** (intentional — the project does not run devnet deploys); the program ID is
  generated but unpublished.
- **Pause gates on the Arcium queue instructions — NOW live-verified (Stage 5C sweep).**
  The Stage 5C `arcium test` (scoring) run passed `Stage 5A: pause halts queue_score_entry
  and queue_reveal_top3` live, and the live breeding run confirmed `start_breeding` is
  *rejected on-chain while paused* (the queue RPC threw — see the note below). So the
  paused-rejection path on all three Arcium queue instructions is now exercised against a
  live cluster. (Previously this was only argued structurally / via bankrun analogues.)
  - *Caveat:* the breeding pause test (`tests/breeding.ts` test 0) FAILS its assertion even
    though the gate fires — under `skipPreflight: true` the rejected-tx error surfaces as
    `Unknown action 'undefined'` instead of a parseable `GamePaused` string. This is a
    **test-assertion defect, not a program bug** (the gate demonstrably rejects the tx — see
    the Stage 5C sweep report). It needs its own reviewed fix; it was deliberately not
    touched in this docs stage.
- **Stage 5B late-callback guards — argued, not live-injected.** The "cancel ran first,
  callback lands later" no-op is proven by code + bankrun state-machine tests, but a real
  late callback cannot be injected from the cluster, so the callback's own no-op branch is
  not executed live. (See `docs/ERROR_AND_STATUS_REFERENCE.md` §3.) **Still open.**
- **`StartBreeding` build diagnostic — present but shown benign in practice.** `arcium build`
  emits a non-fatal SBF "overwrites values in the frame" diagnostic on
  `StartBreeding::try_accounts` (the large queue context, at the 4 KB stack limit since
  Stage 5A added the `config` account). There is NO hard "exceeded max offset" overflow, the
  build exits 0 and produces the `.so`, and the Stage 5C live runs executed `start_breeding`
  + `breed_callback` end-to-end successfully (the scoring suite breeds offspring; breeding
  tests 1–3 pass). So the diagnostic has not manifested as a runtime fault. Tracked as a
  carried-forward concern (a future stage could trim the `StartBreeding` frame); not changed
  here (docs stage).
- **Failure reporting is coarse by design.** Callbacks collapse all MPC failures to a single
  sentinel `error_code` / `score_error_code` (Arcium 0.10.4 passes only Success/Failure to
  the callback; the granular reason is an event). Not a privacy issue, but don't expect
  fine-grained on-chain failure reasons.
