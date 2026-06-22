# Secret Garden Protocol — Error & Status Reference

Structured client reference for the on-chain program at
`7eMfGCkXavfZeVrwRo3ZH63C7H6mZ6n1HZKJwGkZBddo`. Accurate to the code at Stage 5B
(`programs/secret-garden/src/{error,state,constants}.rs` and `lib.rs`). This is reference
material for the Stage 6 frontend; it describes the CURRENT program, not aspirations.

**How to read error codes.** Anchor assigns each `#[error_code]` variant a number
`6000 + declaration_index`. On failure the runtime returns it as a hex `custom program
error` (e.g. `0x1772` = 6002). Account-constraint violations that carry an `@ Error`
surface by that same code; a few low-level Anchor failures (e.g. `AccountNotInitialized`
= 3012 / `0xbc4`) surface by Anchor's own number instead — those are not in this table.

**Player-facing vocabulary.** The `Player message` column uses a small controlled,
garden-themed vocabulary (in the spirit of "Preparing Seed", "Confirm in Wallet",
"Bloom Failed. Try again."). Errors that should never reach a normal player (operator /
internal / structurally-unreachable) are marked **[internal]** with no invented player
copy. A handful where a good player phrasing is genuinely unclear are marked **[FLAG]** —
do not ship those strings without product/design sign-off.

---

## 1. Custom error variants (all stages)

| Code (dec / hex) | On-chain name | On-chain message | Raised by (instruction) | Player message category |
|---|---|---|---|---|
| 6000 / 0x1770 | `AlreadyInitialized` | Game config has already been initialized | `initialize_config` | **[internal]** one-time admin setup |
| 6001 / 0x1771 | `NotAuthority` | Signer is not the configured authority | `set_paused`, `open_round`, `close_round`, `finalize_round`, `init_*_comp_def`, `queue_score_entry`, `queue_reveal_top3` | **[internal]** "This action is for the garden keeper" (admin-only) |
| 6002 / 0x1772 | `GamePaused` | The game is currently paused | `create_profile`, `claim_starters`, `submit_entry`, `open_round`, `start_breeding`, `queue_score_entry`, `queue_reveal_top3` | "The garden is resting. Please check back soon." |
| 6003 / 0x1773 | `ProfileAlreadyExists` | A profile already exists for this wallet | `create_profile` | "Your garden is already planted." (treat as success / route in) |
| 6004 / 0x1774 | `StartersAlreadyClaimed` | Starter flowers have already been claimed | `claim_starters` | "You've already gathered your starter seeds." |
| 6005 / 0x1775 | `InvalidSpecies` | Species index is out of range | `claim_starters` | **[internal]** structurally unreachable (fixed species table) |
| 6006 / 0x1776 | `PreviousRoundNotFinalized` | The previous round has not been finalized | `open_round` | **[internal]** admin sequencing |
| 6007 / 0x1777 | `RoundNotOpen` | The round is not open | `submit_entry` | "Entries for this competition are closed." |
| 6008 / 0x1778 | `RoundDeadlinePassed` | The round deadline has passed | `submit_entry` | "The entry deadline has passed." |
| 6009 / 0x1779 | `RoundFull` | The round is full | `submit_entry` | "This competition is full." |
| 6010 / 0x177a | `FlowerNotOwned` | The flower is not owned by the signer | `submit_entry`, `start_breeding`, `realloc_flower_genome` | "That flower isn't in your garden." |
| 6011 / 0x177b | `FlowerNotActive` | The flower is not active | `submit_entry`, `start_breeding` | "That flower is busy right now." (locked or already entered) |
| 6012 / 0x177c | `RoundNotClosed` | The round is not closed | `queue_score_entry`, `queue_reveal_top3` | **[internal]** admin/scoring sequencing |
| 6013 / 0x177d | `ParentsMustBeDistinct` | The two parents must be distinct flowers | `start_breeding` | "Pick two different flowers to cross." |
| 6014 / 0x177e | `AbortedComputation` | The computation was aborted | `reveal_top3_callback` | **[internal]** surfaced via event/log, not a player action |
| 6015 / 0x177f | `ExperimentNotYetExpired` | The experiment has not yet expired | `cancel_expired_experiment` | **[internal]** client must respect the timeout before offering "try again" |
| 6016 / 0x1780 | `ExperimentAlreadyResolved` | The experiment has already been resolved | `cancel_expired_experiment` | "This cross already finished." (refresh state) |
| 6017 / 0x1781 | `ScoringIncomplete` | Not all entries have been scored yet | `queue_reveal_top3` | **[internal]** admin/scoring sequencing |
| 6018 / 0x1782 | `ScoringAlreadyRevealed` | Scoring has already been revealed | `queue_reveal_top3` | **[internal]** winners already published (refresh state) |
| 6019 / 0x1783 | `EntryAlreadyScored` | This entry has already been scored | `queue_score_entry`, `cancel_stuck_score` | **[internal]** scoring is terminal (refresh state) |
| 6020 / 0x1784 | `WrongEntryCount` | Wrong number of entry accounts for the round | `queue_reveal_top3`, `reveal_top3_callback` | **[internal]** admin client must pass exactly `participant_count` entries |
| 6021 / 0x1785 | `ScoreAlreadyQueued` | A scoring computation is already in flight for this entry | `queue_score_entry` | **[internal]** scoring already running for this entry |
| 6022 / 0x1786 | `ScoreNotQueued` | The entry is not currently queued for scoring | `cancel_stuck_score` | **[internal]** nothing to recover |
| 6023 / 0x1787 | `ScoreNotYetTimedOut` | The scoring computation has not yet timed out | `cancel_stuck_score` | **[internal]** client must respect the timeout before offering recovery |
| 6024 / 0x1788 | `ExperimentNotDead` | The experiment is not in a failed or expired state | `reclaim_dead_offspring` | **[internal]** only failed/expired crosses are reclaimable |
| 6025 / 0x1789 | `OffspringNotReclaimable` | The offspring is not a reclaimable dead flower for this experiment | `reclaim_dead_offspring` | **[internal]** offspring is alive or mismatched |
| 6026 / 0x178a | `InvalidRentDestination` | The rent destination must be the flower owner | `reclaim_dead_offspring` | **[internal]** rent returns only to the flower's owner |

> **General transient/MPC failures** (a breeding or scoring computation that the cluster
> aborts) do NOT surface as one of the codes above to the player who started them. They are
> recorded on the durable account as a sentinel (`Experiment.error_code = 1` /
> `CompetitionEntry.score_error_code = 1`) and the player-facing copy is driven from the
> STATUS tables below, not from a returned error — e.g. a Failed experiment → "Bloom
> Failed. Try again." See §2.1 / §2.2.

---

## 2. Status reference (what to show the player)

Constants referenced (`constants.rs`): `EXPERIMENT_TIMEOUT_SECONDS = 600`,
`SCORE_TIMEOUT_SECONDS = 600`, `ROUND_DURATION_SECONDS = 86_400`. `now` = on-chain
unix time (`Clock`).

### 2.1 `Experiment.status` (`EXPERIMENT_STATUS_*`)

| Value | Name | Notes |
|---|---|---|
| 0 | `Queued` | Set by `start_breeding`. The only "in flight" value actually produced today. |
| 1 | `Processing` | Reserved; **never written** by the current program (kept for forward-compat). `cancel_expired_experiment` accepts it defensively, so clients should treat it identically to `Queued`. |
| 2 | `Completed` | Success callback ran: `result_flower` is now an Active flower with a genome. |
| 3 | `Failed` | Callback ran but the MPC aborted (`error_code = 1`). Parents were unlocked; offspring stays Locked. |
| 4 | `Expired` | `cancel_expired_experiment` ran after timeout. Parents unlocked; offspring stays Locked. |

Client decision table:

| Condition | Show | Enable action |
|---|---|---|
| `status ∈ {Queued, Processing}` AND `now - created_at < EXPERIMENT_TIMEOUT_SECONDS` | "Preparing Seed…" (in progress) | — (wait) |
| `status ∈ {Queued, Processing}` AND `now - created_at >= EXPERIMENT_TIMEOUT_SECONDS` | "Taking longer than expected — you can try again." | `cancel_expired_experiment` (permissionless; unlocks parents) |
| `status == Completed` | Reveal the new bloom (`result_flower`, now Active) | use offspring normally |
| `status == Failed` | "Bloom Failed. Try again." | re-start breeding; optionally `reclaim_dead_offspring` to recover the dead offspring's rent |
| `status == Expired` | "That cross timed out. Your flowers are free again." | re-start breeding; optionally `reclaim_dead_offspring` |

> Parents: `FlowerRecord.status` is `Locked (1)` while `status ∈ {Queued, Processing}`,
> and returns to `Active (0)` on Completed / Failed / Expired. A Completed cross's
> offspring is `Active`; a Failed/Expired cross's offspring stays `Locked` until reclaimed.

### 2.2 `CompetitionEntry` (status + scoring flags)

`status` only ever takes `ENTRY_STATUS_SUBMITTED = 0` today; the meaningful client signal
is the scoring-flag triple `(scored, score_queued, score_error_code)` plus `queued_at`.

| Value | Name | Notes |
|---|---|---|
| 0 | `Submitted` | Set by `submit_entry`. The only entry status today. |

| Condition | Meaning / show | Enable action |
|---|---|---|
| `scored == false` AND `score_queued == false` AND `score_error_code == 0` | "Awaiting judging" (authority hasn't queued scoring yet) | — |
| `score_queued == true` AND `now - queued_at < SCORE_TIMEOUT_SECONDS` | "Judging…" (scoring in flight) | — (wait) |
| `score_queued == true` AND `now - queued_at >= SCORE_TIMEOUT_SECONDS` | "Judging is taking longer than expected." | `cancel_stuck_score` (permissionless; re-enables re-queue) |
| `scored == false` AND `score_queued == false` AND `score_error_code != 0` | last scoring attempt failed; re-queueable | operator: `queue_score_entry` again |
| `scored == true` | Score recorded (encrypted; the value is only made public via `reveal_top3`) | — (terminal) |

> Exactly-once: `score_queued` blocks a second concurrent queue; `scored` is terminal and
> makes any duplicate/late `score_entry_callback` a no-op, so `round.scored_count` counts
> each entry exactly once across any cancel/retry interleaving (see Stage 5B notes, §3).

### 2.3 `CompetitionRound` (status + scoring progress)

| Value | Name | Notes |
|---|---|---|
| 0 | `Open` | Accepting entries until `end_time`. |
| 1 | `Closed` | No more entries; scoring/reveal happen here. |
| 2 | `Finalized` | Round archived; a new round may open. |

| Condition | Show | Enable action |
|---|---|---|
| `status == Open` AND `now < end_time` | "Competition open — submit your bloom!" | `submit_entry` (if you have an Active flower) |
| `status == Open` AND `now >= end_time` | "Entry deadline passed." | operator: `close_round` |
| `status == Closed` AND `scored_count < participant_count` | "Judging entries… (`scored_count`/`participant_count`)" | operator: `queue_score_entry` per entry |
| `status == Closed` AND `scored_count == participant_count` AND `scoring_revealed == false` | "Judging complete — winners coming up." | operator: `queue_reveal_top3` |
| `status == Closed` AND `scoring_revealed == true` | Show winners (`top1`/`top2`/`top3`; `Pubkey::default` = no winner at that rank) | — |
| `status == Finalized` | "Competition complete." | — |

---

## 3. Stage 5B finding: cancel-first / callback-late races

Audit conclusion (proven by `tests/late-callback.ts` + the live suites): **no code gap in
any of the three recovery flows.**

- **Flow 1 — `cancel_expired_experiment` then late `breed_callback`:** safe. `cancel`
  sets `experiment.callback_processed = true` atomically with `Expired`; `breed_callback`'s
  first line `if experiment.callback_processed { return Ok(()) }` makes the late callback a
  no-op before it can touch a flower or counter. Because the callback is bound by account
  constraints to its own experiment (and the cluster only passes that experiment's
  registered accounts), a parent reused in a NEW breeding cannot be flipped out from under
  the new experiment.
- **Flow 2 — `cancel_stuck_score` then late `score_entry_callback`:** safe. `cancel` clears
  `score_queued` but leaves `scored = false`, so a late-but-correct score is harmless; the
  `if entry.scored { return Ok(()) }` guard makes any duplicate callback a no-op, so
  `scored_count` increments exactly once even when a stale and a re-queued callback both
  arrive.
- **Flow 3 — `reveal_top3`:** no cancel path exists and **none is needed.** Reveal is
  authority-triggered, locks no player resource, and `queue_reveal_top3` has no in-flight
  flag, so the authority can re-queue freely while unrevealed (no deadlock). Concurrent
  reveal computations are made safe by `reveal_top3_callback`'s
  `if round.scoring_revealed { return Ok(()) }` idempotency guard.

**Tracked limitation (bankrun):** the Arcium callbacks cannot be executed under bankrun
(their context needs live cluster accounts — `MXEAccount` carries an IDL generic the JS
borsh coder can't synthesize — and the success branch needs a MAC-signed MPC output). The
Stage 5B tests therefore drive the REAL recovery instructions and assert the exact
guard-blocking state each callback inspects at its first line; the callback success path is
covered end-to-end in `tests/scoring.ts` (GAP 1) and `tests/breeding.ts` against a live
cluster.
