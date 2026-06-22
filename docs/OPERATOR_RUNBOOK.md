# Secret Garden Protocol — Operator Runbook

Practical operations guide for the project owner running the on-chain program
`7eMfGCkXavfZeVrwRo3ZH63C7H6mZ6n1HZKJwGkZBddo`. Accurate to the code at Stage 5C. For
error codes and per-account status meanings, see
[`docs/ERROR_AND_STATUS_REFERENCE.md`](./ERROR_AND_STATUS_REFERENCE.md) (this runbook does
not duplicate it).

> **Scope note.** There is no dedicated operator CLI yet (a thin admin script is Stage 6
> work; `migrations/deploy.ts` is currently an empty stub). Today operations are driven via
> Anchor's `program.methods.*(...)` from a TS script/REPL using the authority keypair —
> exactly as the live test suites do (`tests/scoring.ts`, `tests/breeding.ts`). The
> command snippets below mirror those suites' helper calls verbatim so they are known-good.

---

## 0. Roles & one-time setup

- **`authority`** — the wallet in `GameConfig.authority` (set at `initialize_config`). It is
  the only signer allowed to: `set_paused`, `open_round`, register the three Arcium
  computation definitions, `queue_score_entry`, `queue_reveal_top3`. The round operator
  (`round.authority`, currently the same wallet) also signs `close_round` / `finalize_round`.
- **Players** — any wallet; sign `create_profile`, `claim_starters`, `submit_entry`,
  `start_breeding`.
- **Anyone (permissionless)** — `cancel_expired_experiment`, `cancel_stuck_score`,
  `reclaim_dead_offspring` (recovery; the caller gains nothing).

One-time, in order (authority):

1. `initialize_config` — creates the singleton `GameConfig` (`paused = false`).
2. `init_breeding_comp_def` — registers the `breed` circuit.
3. `init_score_entry_comp_def` — registers the `score_entry` circuit.
4. `init_reveal_top3_comp_def` — registers the `reveal_top3` circuit.

> The three comp-def registrations require a live Arcium cluster + MXE key (see §4). Run
> them once after deploy; they are not part of the daily loop.

---

## 1. Daily round operation

The canonical sequence (this is exactly `tests/scoring.ts`'s `runRound` helper):

```
open_round                      # authority
  → players call submit_entry   # players, until end_time or max_participants (16)
close_round                     # authority/operator
  → queue_score_entry  ×N       # authority, ONE per entry; await each callback
queue_reveal_top3               # authority, pass all N entries as remaining_accounts; await
finalize_round                  # authority/operator (lets the next round open)
```

### Step-by-step

**a) Open the round** (authority). `open_round` requires the previous round (if any) to be
`Finalized`; pass `previousRound = null` for the very first round. Sets
`end_time = start_time + 24h`, `max_participants = 16`, and generates the round's PUBLIC
target traits.

```ts
await program.methods.openRound()
  .accountsPartial({ authority: authority.publicKey, config: configPda,
    previousRound: current > 0 ? roundPda(current) : null, round: roundPda(current + 1) })
  .signers([authority]).rpc({ commitment: "confirmed" });
```

**b) Monitor the open round.** Poll `CompetitionRound`:
- accepting entries while `status == Open` and `now < end_time`;
- `participant_count` rising toward `max_participants` (16) — submissions fail with
  `RoundFull` once full;
- once `now >= end_time`, no new entries are valid (`RoundDeadlinePassed`) — proceed to close.

**c) Close the round** (authority/operator). `Open → Closed`. There is intentionally no time
check — you may close early or late. **Not pause-gated** (see §2).

**d) Score every entry** (authority). Call `queue_score_entry(offset)` ONCE per entry, then
wait for the MPC callback to persist the score (`entry.scored` flips true and
`round.scored_count` increments). The score itself stays encrypted.

```ts
await program.methods.queueScoreEntry(offset)
  .accountsPartial({ authority: authority.publicKey, round, entry, flowerRecord: flower,
    ...queueAccsFor("score_entry", offset) })   // mxe/mempool/execpool/comp/compDef/cluster/...
  .signers([authority]).rpc({ skipPreflight: true, commitment: "confirmed" });
await awaitFinalize(offset);                      // arcium.awaitComputationFinalization(...)
// then poll entry.scored until true
```

- `queue_score_entry` refuses an already-scored entry (`EntryAlreadyScored`) or one that
  already has a computation in flight (`ScoreAlreadyQueued`) — so it is safe to re-run for
  an entry whose first attempt failed (`scored == false` again after a failed callback).
- A score that is queued but never calls back is recoverable after the timeout (see §3).

**e) Reveal the top 3** (authority). Only once `scored_count == participant_count`. Pass
the round's `CompetitionEntry` accounts as `remainingAccounts` (exactly `participant_count`
of them); the program reads each score from its own account (scores are never supplied by
the caller). Await the callback; it writes `top1/top2/top3` and sets `scoring_revealed`.

```ts
await program.methods.queueRevealTop3(offset)
  .accountsPartial({ authority: authority.publicKey, round, ...queueAccsFor("reveal_top3", offset) })
  .remainingAccounts(entries.map(pk => ({ pubkey: pk, isWritable: false, isSigner: false })))
  .signers([authority]).rpc({ skipPreflight: true, commitment: "confirmed" });
await awaitFinalize(offset);   // then poll round.scoring_revealed until true
```

- Ranks `< participant_count` for `top2`/`top3` are left as `Pubkey::default()` (no fake
  winners in small rounds).

**f) Finalize** (authority/operator). `Closed → Finalized`, which unblocks the next
`open_round`. **Not pause-gated.**

### Realistic timing expectations

These are **MPC round-trips against a live Arcium cluster**, dominated by cluster latency,
not the program:

- **Breeding (`start_breeding` → `breed_callback`)** — measured in the **Stage 3B** live run
  (`tests/breeding.ts`, 2-node localnet on a WSL2 host): roughly **~14992 ms** for the
  first computation and **~5082 ms / ~5444 ms** for subsequent ones. The first call is
  slower because it absorbs cluster/MXE warmup; steady-state is **~5 s per computation**.
- **Scoring (`queue_score_entry` → callback)** — the same per-computation MPC round-trip
  class (~5 s steady-state). Exact per-call numbers were **not separately recorded** in
  Stage 4B; read them from `arcium test` console output when you run a round. Budget one
  ~5 s computation **per entry** (16 entries ≈ ~80 s of scoring, serially) plus the cold
  first-call warmup.
- **`reveal_top3`** — a single computation (~5 s class) regardless of participant count.
- **First call after a cold cluster start** also pays MXE key generation (DKG), which on
  the WSL2 localnet is slow — see §4.

> The bankrun suite (`yarn test`) is instant and deterministic but does NOT exercise MPC; it
> is for regression, not latency estimation.

---

## 2. Using `set_paused` (kill-switch)

`set_paused(true|false)` is authority-only and flips `GameConfig.paused`.

**When to pause:**
- Suspected exploit or anomalous on-chain activity.
- Arcium cluster instability (computations failing/aborting in bulk).
- Immediately before a planned program upgrade or migration.

**Blocked while paused** (reject with `GamePaused`, code 6002):
`create_profile`, `claim_starters`, `submit_entry`, `open_round`, `start_breeding`,
`queue_score_entry`, `queue_reveal_top3`. (Verified in code: the `!config.paused`
constraint is on exactly these seven.)

**Still callable while paused** (deliberate):
- **Recovery:** `cancel_expired_experiment`, `cancel_stuck_score`, `reclaim_dead_offspring`
  — a stuck experiment/score must be recoverable even with the game halted.
- **In-flight resolution:** all three callbacks (`breed_callback`, `score_entry_callback`,
  `reveal_top3_callback`) are not pause-gated, so computations already queued before the
  pause still resolve normally.
- **Round wind-down:** `close_round`, `finalize_round` (no pause gate) — you can still close
  out an in-progress round while paused.
- `set_paused` itself, and the one-time `init_*` / `initialize_config`.

So pausing stops NEW player and scoring activity but lets in-flight work drain and lets
recovery proceed. Unpause with `set_paused(false)`.

> **Live-verification status.** The pause gates on the three Arcium queue instructions
> (`start_breeding`, `queue_score_entry`, `queue_reveal_top3`) are now confirmed against a
> live cluster (Stage 5C sweep): the scoring suite live-passes the score/reveal pause test,
> and the live breeding run confirmed `start_breeding` is rejected on-chain while paused.
> (One breeding *test assertion* is defective despite the gate firing — see
> [`docs/PRIVACY_AND_ARCHITECTURE.md`](./PRIVACY_AND_ARCHITECTURE.md) §"Open verification
> items".)

---

## 3. Monitoring for stuck state & recovery

Two timeouts (both 600 s = 10 min; `constants.rs`): `EXPERIMENT_TIMEOUT_SECONDS`,
`SCORE_TIMEOUT_SECONDS`. The recovery instructions are **permissionless**, so a motivated
player can self-heal their own stuck state — but the operator should sweep periodically in
case no one does.

**Stuck breeding experiment.** Scan `Experiment` accounts where
`status ∈ {Queued, Processing}` and `now - created_at >= EXPERIMENT_TIMEOUT_SECONDS`.
- Call **`cancel_expired_experiment`** → unlocks both parents (back to `Active`), marks the
  experiment `Expired`, and sets `callback_processed = true` so a late callback no-ops.
- The pre-created offspring stays `Locked` (a dead, rent-funded account). Optionally call
  **`reclaim_dead_offspring`** on a `Failed`/`Expired` experiment to return that rent to the
  flower's owner (rent always goes to the owner, never the caller).

**Stuck scoring.** Scan `CompetitionEntry` accounts where `score_queued == true` and
`now - queued_at >= SCORE_TIMEOUT_SECONDS`.
- Call **`cancel_stuck_score`** → clears `score_queued` (the entry stays `scored == false`),
  making it re-queueable. `round.scored_count` is untouched, so a later retry still counts
  exactly once.
- Then re-run `queue_score_entry` for that entry.

**Why this is safe with late callbacks** (Stage 5B audit): cancel and the eventual callback
can't both take effect — the callback's first-line guard (`callback_processed` for breeding,
`scored` for scoring) makes a late callback a no-op. Details:
[`docs/ERROR_AND_STATUS_REFERENCE.md`](./ERROR_AND_STATUS_REFERENCE.md) §3.

**Decision tables** (status + timestamp → what to do) live in
[`docs/ERROR_AND_STATUS_REFERENCE.md`](./ERROR_AND_STATUS_REFERENCE.md) §2 — use those as
the monitoring checklist.

---

## 4. Known infrastructure caveat — WSL/localnet MXE keygen (DKG) flake

**Confirmed** (observed repeatedly across Stages 3B / 4B / 5A / 5B on this WSL2 host): the
Arcium localnet's MXE key generation (the distributed key-gen run by the 2-node cluster on
first start) is **slow and intermittently does not finish within the default window**.
Symptom: the test/operation fails with an "MXE public key unavailable" / "Failed to fetch
MXE public key" style error after the timeout. The project already raised
`Arcium.toml`'s `localnet_timeout_secs` to **300** and the breeding test polls ~4 minutes
for the key to mitigate this.

**Fix that has worked before** (confirmed): run **`arcium clean`** before retrying
`arcium test` — stale keygen/build state from a previous localnet run otherwise makes the
fresh DKG fail. `tests/scoring.ts`'s header documents `arcium clean` before each localnet
run for exactly this reason.

**Reasonable hypotheses (NOT confirmed):**
- The slowness is environmental (WSL2 I/O / Docker-on-WSL networking), so a native Linux or
  a real devnet/managed cluster would likely be faster and steadier. This is plausible but
  has not been measured here — do not assume it as fact.
- A managed devnet cluster would sidestep local DKG entirely. Unverified in this project
  (this project does **not** deploy to devnet — see the engineering rules).

**Operational guidance:** on any new environment, do a cold `arcium clean && arcium test`
dry-run once to confirm the cluster reaches "MXE key available" before relying on the
daily loop; if it flakes, `arcium clean` and retry once before investigating further.

---

## 5. Troubleshooting

- **An instruction returned a `custom program error: 0x….`** → look up the hex/decimal in
  [`docs/ERROR_AND_STATUS_REFERENCE.md`](./ERROR_AND_STATUS_REFERENCE.md) §1 (every variant,
  which instruction raises it, and the player-facing category).
- **"What should the UI show for this account state?"** → §2 of the same doc (decision
  tables for Experiment / CompetitionEntry / CompetitionRound).
- **A computation never called back** → §3 above (timeouts + recovery).
- **"MXE public key unavailable"** → §4 above (`arcium clean`, raise timeout).
- **Players report a flower stuck "in the greenhouse" / locked** → it is a breeding parent
  (`Locked`); resolves on the callback, or via `cancel_expired_experiment` after 10 min. See
  [`docs/PLAYER_HELP_REFERENCE.md`](./PLAYER_HELP_REFERENCE.md).
