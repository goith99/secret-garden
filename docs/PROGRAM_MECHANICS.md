# Secret Garden — Program Mechanics Reference

A complete description of the on-chain rules for the Secret Garden program, covering **both**
deployments. Written for a contributor or auditor arriving with no prior context.

| | production | dev |
|---|---|---|
| program id | `7eMfGCkXavfZeVrwRo3ZH63C7H6mZ6n1HZKJwGkZBddo` | `34JWa5vNViWgonTKcn4CSQBhU8YFf8PyLMbCZizHFxXP` |
| cluster | Solana devnet, Arcium cluster offset **456** | same cluster, same MXE pool |
| config PDA | `35pB3aMQWjh1v2SDQAYvN5aAuNCvkRcaduM27sgnkw17` | `6xjxifKdoKy67qW4aQe6ZprwsxesKJ8KJ2yYLQzPfzjq` |
| instructions | 48 | 50 |

> Both "production" and "dev" run on devnet. "Production" means the deployment real players use.

Verified against source and live chain state on **2026-08-26**. Every claim below was re-checked
against current code rather than carried over from memory; where a figure is derived from live
accounts it is marked *(live)*.

---

## 1. Instructions

Anchor discriminators are `sha256("global:<name>")[0..8]`. "Signer" is the account that must sign.

### Setup and administration

| instruction | signer | what it does | writes |
|---|---|---|---|
| `initialize_config` | authority | Creates the singleton `GameConfig`. Callable once — `init` fails on the second call. | GameConfig |
| `create_profile` | player | Creates the player's `PlayerProfile`. | PlayerProfile |
| `claim_starters` | player | Mints the six starter `FlowerRecord`s in one transaction. | 6 × FlowerRecord, PlayerProfile |
| `set_paused` | **authority only** | Flips the global kill-switch. | GameConfig |
| `set_mutant_weight` | **authority only** | Sets `mutant_weight` + `restore_ts` (Mutant target damping). | GameConfig |
| `migrate_config` | **authority only** | Grows GameConfig in place to the current layout. Idempotent. Takes the account **raw** (`UncheckedAccount`) because a short config cannot deserialize. | GameConfig |
| `add_operator` / `remove_operator` | **authority only** | Manages up to 3 operator wallets. | GameConfig |

### Rounds

| instruction | signer | what it does | writes |
|---|---|---|---|
| `open_round` | authority **or** operator | Opens round `current_round + 1`, picking 2–4 public target traits. Requires the previous round Finalized. | CompetitionRound, GameConfig |
| `submit_entry` | player | Enters one flower. One entry per wallet per round. | CompetitionEntry, FlowerRecord→SUBMITTED, CompetitionRound, PlayerProfile |
| `close_round` | authority **or** operator | OPEN → CLOSED. Operators must wait `MIN_OPERATOR_CLOSE_DELAY_SECONDS`; the authority may close at any time. | CompetitionRound |
| `finalize_round` | authority **or** operator | CLOSED → FINALIZED. **Does not require scoring or reveal** — a round can be finalized unscored. | CompetitionRound |
| `release_flower` | player | "Bring Back": SUBMITTED → ACTIVE once the round is Finalized. | FlowerRecord, CompetitionEntry |

### Breeding

| instruction | signer | what it does | writes |
|---|---|---|---|
| `init_breeding_comp_def` | authority | Registers the breeding circuit's Arcium computation definition. | comp-def account |
| `start_breeding` | player | Locks both parents, pre-creates the offspring, queues the MPC computation. | 2 × FlowerRecord→LOCKED, Experiment, offspring FlowerRecord, PlayerProfile, sign-PDA |
| `breed_v5_callback` | Arcium node | Writes the offspring genome + commitment, unpacks rarity, unlocks parents, completes the Experiment. Idempotent via `callback_processed`. | offspring, parents, Experiment, PlayerProfile |
| `cancel_expired_experiment` | anyone | Recovers parents from an experiment older than `EXPERIMENT_TIMEOUT_SECONDS`. Permissionless recovery. | Experiment, parents |
| `reclaim_dead_offspring` | owner | Reclaims rent from an offspring whose breed failed/expired. | closes offspring, PlayerProfile |
| `close_flower` | owner | Deletes a hybrid and reclaims rent. Starters are permanent. **This is the UI's "Release".** | closes FlowerRecord, PlayerProfile |

### Scoring, hints and reveal

| instruction | signer | notes |
|---|---|---|
| `init_score_entry_comp_def`, `init_reveal_top3_comp_def`, `init_reveal_top3_v3_comp_def`, `init_private_hint_comp_def` | authority | One-time circuit registration. |
| `queue_score_entry` | authority/operator | Queues `score_entry_v2` for one entry. |
| `score_entry_v2_callback` | Arcium node | Stores the encrypted score. |
| `cancel_stuck_score` | authority/operator | Clears a scoring computation past `SCORE_TIMEOUT_SECONDS`. |
| `queue_private_hint` | player | Sealed per-player hint. **Not pause-gated** — see §3. |
| `private_hint_callback` | Arcium node | Writes the sealed bitmask to `HintResult`. |
| `queue_reveal_top3`, `queue_reveal_top3_v3` | authority/operator | Legacy monolithic reveal paths. Retired from the auto-cycle but still callable. |
| `reveal_top3_callback`, `reveal_top3_v5_callback` | Arcium node | Reveal results. |

### Bracket reveal (the current reveal path)

Single tier for ≤ 52 entries, two tier up to 221.

| instruction | signer | notes |
|---|---|---|
| `init_bracket` / `init_tier1_bracket` | authority/operator | Declares the partition. Verified, not trusted: strict ascending pubkey order, per-shard bounds, sizes summing to `participant_count`. |
| `queue_shard_reveal` / `queue_tier1_shard_reveal` | authority/operator | One MPC call per shard. `shard_index = 255` selects the final reveal. |
| `collect_shard_winners` / `collect_tier1_winners` | authority/operator | Reads a shard result into bracket state. |
| `promote_tier1` | authority/operator | Tier-1 winners → semifinal tier. |
| `queue_semifinal_reveal` / `collect_semifinal_winners` | authority/operator | Semifinal round. |
| `apply_bracket_result` | authority/operator | Writes `top1/2/3` and sets `scoring_revealed`. |
| `close_tier1_bracket` | authority/operator | Reclaims the zero-copy `Tier1State` rent. |

### Migrations

| instruction | signer | notes |
|---|---|---|
| `realloc_flower_genome` | owner | Stage-3A genome append. |
| `migrate_profile` | owner | Grows a pre-5D 68-byte profile. |
| `migrate_flower` | owner | Grows a pre-5E 528-byte FlowerRecord by one byte. |
| `operator_migrate_flower` | authority/operator | Same realloc, operator pays. Grants **no** power over contents: takes the account raw and only calls `resize`, which appends zero bytes and cannot alter existing ones. |
| `migrate_entry` | authority/operator | **PRODUCTION ONLY.** Grows a pre-`rarity_snapshot` CompetitionEntry. |

### PDA derivations

```
config      [b"config"]
profile     [b"profile", owner]
flower      [b"flower",  owner, flower_index_u32_le]
round       [b"round",   round_id_u64_le]
entry       [b"entry",   round_pubkey, player]
experiment  [b"experiment", owner, index_u32_le]
hint        [b"hint",    player]
bracket     [b"bracket", round_pubkey]
tier1       [b"tier1",   round_pubkey]
shardres    [b"shardres", round_pubkey, shard_index_u8]
semires     [b"semires",  round_pubkey, semi_index_u8]
top3v3      [b"top3v3",  round_pubkey]
top3v2      [b"top3v2",  round_pubkey]     <- DEV ONLY
```

---

## 2. Error codes

`SecretGardenError` is **identical in both programs**: 57 variants, Anchor base 6000, codes
6000–6056. Full table:

| code | variant | trigger |
|---|---|---|
| 6000 | `AlreadyInitialized` | second `initialize_config` |
| 6001 | `NotAuthority` | signer isn't the config authority (or operator, where allowed) |
| 6002 | `GamePaused` | any pause-gated instruction while `paused == true` |
| 6003 | `ProfileAlreadyExists` | second `create_profile` |
| 6004 | `StartersAlreadyClaimed` | second `claim_starters` |
| 6005 | `InvalidSpecies` | species index out of range |
| 6006 | `PreviousRoundNotFinalized` | `open_round` before the previous round is Finalized |
| 6007 | `RoundNotOpen` | `submit_entry` / `close_round` on a non-open round |
| 6008 | `RoundDeadlinePassed` | `submit_entry` after `end_time` |
| 6009 | `RoundFull` | `participant_count == max_participants` |
| 6010 | `FlowerNotOwned` | flower's `owner != signer` |
| 6011 | `FlowerNotActive` | flower not ACTIVE (mid-breed or submitted) |
| 6012 | `RoundNotClosed` | `finalize_round` on a non-closed round |
| 6013 | `ParentsMustBeDistinct` | `start_breeding` with the same flower twice |
| 6014 | `AbortedComputation` | MPC computation aborted |
| 6015 | `ExperimentNotYetExpired` | cancel before `EXPERIMENT_TIMEOUT_SECONDS` |
| 6016 | `ExperimentAlreadyResolved` | cancel/callback on a resolved experiment |
| 6017 | `ScoringIncomplete` | reveal before all entries scored |
| 6018 | `ScoringAlreadyRevealed` | second reveal |
| 6019 | `EntryAlreadyScored` | re-score |
| 6020 | `WrongEntryCount` | wrong number of entry accounts |
| 6021 | `ScoreAlreadyQueued` | double-queue scoring |
| 6022 | `ScoreNotQueued` | cancel a score that isn't queued |
| 6023 | `ScoreNotYetTimedOut` | cancel before `SCORE_TIMEOUT_SECONDS` |
| 6024 | `ExperimentNotDead` | reclaim from a live experiment |
| 6025 | `OffspringNotReclaimable` | offspring isn't this experiment's dead flower |
| 6026 | `InvalidRentDestination` | rent must go to the flower owner |
| 6027 | `BreedingLimitReached` | `MAX_BREEDS_PER_ROUND` (5) spent this round |
| 6028–6031 | `OperatorSlotsFull`, `OperatorAlreadyExists`, `OperatorNotFound`, `InvalidOperator` | operator administration |
| 6032 | `RoundTooRecentToClose` | operator closing before `MIN_OPERATOR_CLOSE_DELAY_SECONDS` |
| 6033 | `NoActiveRound` | hint requested with no open round |
| 6034 | `CollectionFull` | `FLOWER_COLLECTION_CAP` (20) live hybrids |
| 6035 | `StarterNotDeletable` | `close_flower` on a starter |
| 6036–6045 | `InvalidShardLayout`, `ShardEntriesOutOfRange`, `InvalidShardIndex`, `ShardResultNotReady`, `ShardAlreadyCollected`, `BracketNotReady`, `BracketAlreadyFinal`, `FinalistMismatch`, `BracketRoundMismatch`, `WrongBracketTier` | bracket partition validation |
| 6046–6050 | `Tier1NotReady`, `Tier1AlreadyPromoted`, `SemifinalNotReady`, `SemifinalSliceMismatch`, `Tier1WinnerRejected` | two-tier bracket |
| 6051 | `StaleRevealResult` | reveal result from a superseded partition generation |
| 6052 | `RoundNotFinalized` | `release_flower` before finalize |
| 6053 | `FlowerNotSubmitted` | `release_flower` on a non-submitted flower |
| 6054 | `EntryMismatch` | entry doesn't match the round/flower |
| 6055 | `EntryAlreadyReleased` | double release |
| 6056 | `FlowerParentLimitReached` | `MAX_BREEDS_AS_PARENT` (3) reached |

### Non-program errors seen in practice

These come from Anchor or from the Arcium program, not from this codebase. Each cost real
debugging time historically.

| code | source | meaning and cause |
|---|---|---|
| **2012** `ConstraintAddress` | Anchor | An `#[account(address = …)]` constraint failed. **In practice this always means a stale circuit name.** The program derives its comp-def PDA from its own `comp_def_offset("<name>")`; a client passing a different circuit's PDA fails here. Hit three times: the frontend's `CIRCUITS.breed`, `tests/rarity.devnet.ts`, and a deployment running a revision that still named `reveal_top3_v3`. |
| **6301** `InvalidArguments` | Arcium | The argument payload doesn't match the signature the comp-def was registered against. A comp-def stores its circuit's **argument signature**, so adding or removing a circuit parameter requires a **new circuit name** — the definition cannot be re-uploaded in place. This is why `breed` → `breed_v2` → `breed_v3` → `breed_v5` exist. |
| **6202** `InvalidCallbackAccsLen` | Arcium | Thrown inside the `queue_computation` CPI. Misleadingly named: it is **not** about callback-account count. Measured behaviour is that `queue_reveal_top3` and `_v3` are accepted at N ≤ 14 and rejected at N ≥ 15, regardless of callback accounts. It is a limit on the number of **distinct account references** in the argument list. This is what made `MAX_PARTICIPANTS = 16` unreachable and forced the bracket design. |
| **102** | Arcium callback | Callback reverted. Historically caused by widening the breed circuit's return from a 2-tuple to a 3-tuple; the callback reverted and left the Experiment `QUEUED` forever. One such zombie experiment from 2026-07-26 still exists on production. |
| `AccountDidNotDeserialize` | Anchor | A typed `Account<T>` was handed an account **shorter** than the current struct. This is the migration trap: after a struct grows, every un-migrated account fails until its `migrate_*` runs. Note the asymmetry — a **longer** account decodes fine (Borsh ignores trailing bytes), which is why old clients keep working after an append. |

---

## 3. Gating conditions

### The pause kill-switch — definitive list

`GameConfig.paused` gates **16 instruction contexts in production, 17 in dev** (dev adds
`QueueRevealTop3V2`). Verified by scanning every `!config.paused` constraint in both trees.

**Pause-gated (production):**

*Player-facing (6):* `CreateProfile` · `ClaimStarters` · `SubmitEntry` · `StartBreeding` ·
`ReleaseFlower` · `CloseFlower`

*Operator-only (10):* `OpenRound` · `QueueScoreEntry` · `QueueRevealTop3` · `QueueRevealTop3V3` ·
`InitBracket` · `QueueShardReveal` · `InitTier1Bracket` · `QueueTier1ShardReveal` ·
`PromoteTier1` · `QueueSemifinalReveal`

**NOT pause-gated — and each omission is deliberate:**

- **`queue_private_hint`** — a paused garden still lets a player inspect their own flower. This is
  the one player action that survives a pause, and any UI must keep it enabled.
- **`close_round`, `finalize_round`** — winding down in-flight state must work while paused,
  otherwise pausing would strand an open round.
- **all `*_callback`s** — the Arcium node must always be able to land a result.
- **`cancel_expired_experiment`, `reclaim_dead_offspring`, `cancel_stuck_score`** — permissionless
  recovery paths.
- **`collect_*`, `apply_bracket_result`** — collection is bookkeeping over results already produced.
- **all `migrate_*`, `set_paused`, operator administration** — administration must work while paused.

> **Consequence worth knowing.** 19 instruction contexts take a typed `Account<GameConfig>`. Between a
> program upgrade that grows the struct and the `migrate_config` that grows the account, *all* of
> them fail with `AccountDidNotDeserialize` — the whole game is down, not just round-opening.
> `migrate_config` must run immediately after any such upgrade.

### Per-instruction rejection conditions

**`start_breeding`** — checked in this order, all before any state mutation (fail fast, no wasted
rent or MPC):
1. `!config.paused`
2. `profile.register_breed_attempt(round)` → `BreedingLimitReached` if 5 used this round
3. `profile.check_collection_cap()` → `CollectionFull` at 20 live hybrids
4. `flower_a/b.check_breed_as_parent()` → `FlowerParentLimitReached` at 3 uses — **both checked
   before either is spent**, so a rejected breed never consumes one parent's budget
5. account constraints: both parents `owner == player`, both `status == ACTIVE`,
   `flower_b.key() != flower_a.key()`

**`submit_entry`** — `!config.paused` · `flower.owner == player` · `flower.status == ACTIVE` ·
`round.status == OPEN` · `now < round.end_time` · `participant_count < max_participants`

**`release_flower`** — `!config.paused` · `round.status == FINALIZED` · `entry.round == round` ·
`entry.flower_record == flower` · `entry.status == SUBMITTED` · `flower.owner == owner` ·
`flower.status == SUBMITTED` · `flower.genome_status == ENCRYPTED`

**`close_flower`** — `!config.paused` · `flower.owner == signer` · `status == ACTIVE` ·
`genome_status == ENCRYPTED` (starters are permanent) · rent destination must be the owner

**`open_round`** — `!config.paused` · authority or operator · previous round exists, its
`round_id == current_round`, and its `status == FINALIZED`

**`close_round`** — authority or operator · `status == OPEN` · **operators only** must satisfy
`now - start_time >= MIN_OPERATOR_CLOSE_DELAY_SECONDS`; the authority may close at any time

**`finalize_round`** — authority or operator · `status == CLOSED`. Nothing else. A round can be
finalized without ever being scored or revealed.

---

## 4. Limits and constants

**Only two constants differ between the programs**: `ENTRY_FLOWER_OFFSET` (production only, for
`migrate_entry`) and `TOP3_V2_SEED` (dev only). Every gameplay value below is identical in both.

### Gameplay caps

| constant | value | meaning |
|---|---|---|
| `STARTER_COUNT` | 6 | starters granted at claim; permanent, never deletable |
| `FLOWER_COLLECTION_CAP` | 20 | live **hybrids** per player (`total_flowers − STARTER_COUNT`) |
| `MAX_BREEDS_PER_ROUND` | 5 | per-player breeding budget, resets each round |
| `MAX_BREEDS_AS_PARENT` | 3 | lifetime per-flower parent budget, spent at queue time, **never refunded** |
| `ROUND_DURATION_SECONDS` | 86 400 | 24h |
| `MIN_OPERATOR_CLOSE_DELAY_SECONDS` | 3 600 | operator close delay; authority exempt |
| `EXPERIMENT_TIMEOUT_SECONDS` | 600 | before an experiment can be cancelled |
| `SCORE_TIMEOUT_SECONDS` | 600 | before a stuck score can be cancelled |
| `MAX_SCORE` | 100 | |
| `BREEDING_STABILITY_PENALTY` | 5 | subtracted from the parent average |
| `STARTER_STABILITY` | 100 | |

### Round capacity

| constant | value | note |
|---|---|---|
| `MAX_PARTICIPANTS` | 16 | the **reveal circuit's** fixed slot width — *not* the round cap |
| `MAX_SHARD_SIZE` | 13 | design point; the Arcium 6202 cliff is at 15 |
| `MAX_SHARDS` | 4 | |
| `SINGLE_TIER_CAPACITY` | **52** | 4 × 13 |
| `MAX_TIER1_SHARDS` | 17 | |
| `TWO_TIER_CAPACITY` | **221** | 17 × 13 |
| `ROUND_CAPACITY` | **221** | what a round actually accepts |
| `MAX_FINALISTS` | 12 | 4 × 3 |
| `MAX_TIER1_WINNERS` | 51 | 17 × 3 |
| `REVEAL_TOP_K` / `SHARD_WINNERS` | 3 | |
| `FINAL_SHARD_INDEX` | 255 | sentinel selecting the final reveal |
| `MAX_REVEAL_ACCOUNT_REFS` | 14 | the measured 6202 boundary |

> `MAX_PARTICIPANTS = 16` is a historical trap. A 16-entry round could be opened, filled and
> scored, then became permanently **unrevealable** because both monolithic reveal paths reject at
> N ≥ 15 with Arcium 6202. The bracket exists to decouple round size from circuit width.

### Traits and rarity

| constant | value |
|---|---|
| `TRAIT_TABLE_LEN` | 10 |
| `TARGET_TRAIT_MIN` / `MAX` | 2 / 4 |
| `TRAIT_ID_MUTANT` | 8 |
| `RARITY_COMMON…LEGENDARY` | 1 … 5 |
| `RARITY_SHIFT` | 19 (bits 19–21 of the revealed mask) |
| `RARITY_STRIP_MASK` | `0xFFC7_FFFF` |
| `RARITY_BASE_UNCOMMON/RARE/EPIC/LEGENDARY` | 115 / 192 / 230 / 251 |
| `RARITY_EPIC_LIFT_DIV` / `LEGENDARY_LIFT_DIV` | 4 / 8 |
| `RARITY_GENERATION_CAP` / `WEIGHT` | 10 / 1 |
| `MUTANT_WEIGHT_UNIFORM` | 255 |
| `MUTANT_GATE_ENTROPY_INDEX` | 5 |
| `GAME_CONFIG_MUTANT_WEIGHT_OFFSET` | 149 |

### Account sizes and byte offsets

| constant | value |
|---|---|
| `GENOME_COMMITMENT_LEN` | 32 |
| `ENCRYPTED_GENOME_LEN` | 320 (10 scalars × 32 B) |
| `ENCRYPTION_METADATA_LEN` | 16 (MXE nonce, LE u128) |
| `FLOWER_ENCRYPTED_GENOME_OFFSET` | 192 |
| `FLOWER_RARITY_OFFSET` | 47 |
| `ENTRY_SCORE_OFFSET` | 114 |
| `ENTRY_FLOWER_OFFSET` | 72 *(production only)* |
| `SIGN_PDA_ACCOUNT_LEN` | 9 |

Rent throughout is `(128 + data_len) × 6960` lamports (2 years × 3480 lamports/byte-year).

**Live account sizes** *(live, 2026-08-26)*:

| account | production | dev |
|---|---|---|
| GameConfig | **158 B** (migrated) | **149 B** (not migrated) |
| PlayerProfile | 73 B (2 legacy at 68) | 73 B |
| FlowerRecord | 529 B (all migrated) | 529 B |
| CompetitionRound | 174 B | 174 B |
| CompetitionEntry | 175 B (4 legacy at 174) | **174 B** (no `rarity_snapshot`) |
| Experiment | 165 B | 165 B |
| HintResult | 139 B | 139 B |
| Tier1State | 2258 B | 2254 B |

### Circuits — live deployment status *(live)*

| circuit | production | dev |
|---|---|---|
| `breed` | registered, 241 623 B (legacy) | registered, 241 623 B (legacy) |
| `breed_v2` | — | registered, 284 382 B (legacy) |
| `breed_v3` | registered, 278 753 B (superseded) | registered, 278 729 B (superseded) |
| `breed_v5` | **LIVE, 282 005 B** | **LIVE, 281 981 B** |
| `score_entry` | registered, 100 806 B (legacy) | — |
| `score_entry_v2` | **LIVE, 163 085 B** | **LIVE, 163 085 B** |
| `private_hint` | **LIVE, 63 099 B** | **LIVE, 63 099 B** |
| `reveal_top3` | registered, 523 413 B | registered, 523 413 B |
| `reveal_top3_v2` | — | registered, 194 517 B |
| `reveal_top3_v3` | registered, 249 491 B | registered, 249 491 B |
| `reveal_top3_v5` | **LIVE, 316 875 B** | **LIVE, 316 875 B** |

> Superseded comp-defs are **never** closed and never can be: closing requires an empty cluster
> execpool, and another MXE's expired computations have squatted cluster 456's since 2026-08-02.
> Their existence therefore proves nothing about what is live — only the deployed binary's
> `comp_def_offset(..)` constant does. This is exactly what `scripts/auto-cycle.ts`'s pre-flight
> scans for.

---

## 5. Genome and trait mechanics

### The genome

Ten `u8` fields, each encrypted as one BN254 field element — `Enc<Mxe, Genome>` serialises to
**10 × 32 = 320 bytes** plus a 16-byte nonce:

```
color_gene  petal_gene  leaf_gene  stem_gene  aroma_gene
climate_gene  recessive_mask  mutation_affinity  stability  reserved
```

The genome is **never** decrypted on-chain. Every predicate over it runs inside MPC.

### Trait table

`trait_satisfied` (in `encrypted-ixs/src/lib.rs`) is the canonical, and only executable,
definition. It is shared by `score_entry_v2` and `private_hint`, so a hint and the score it
previews cannot disagree.

| id | name | condition |
|---|---|---|
| 0 | Crimson | `color_gene >= 180` |
| 1 | Pale | `color_gene < 64` |
| 2 | Full Bloom | `petal_gene >= 150` |
| 3 | Broadleaf | `leaf_gene >= 128` |
| 4 | Tall | `stem_gene >= 160` |
| 5 | Fragrant | `aroma_gene >= 150` |
| 6 | Hardy | `climate_gene >= 140` |
| 7 | Recessive Carrier | `recessive_mask >= 32` |
| 8 | **Mutant** | `mutation_affinity % 2 == 1` |
| 9 | Stable | `stability >= 150` |

> **No starter can ever be Mutant.** The six starter genomes carry `mutation_affinity` of
> 50, 90, 60, 70, 40, 80 (and a 64 fallback) — every one even, so `% 2 == 1` is never true.
> Mutant is a hybrid-only trait.

### Scoring

`score_entry_v2` computes a synergy multiplier as **two separately-floored terms**:

```
score = floor(matched * 70 / count) + floor(matched * gen_bonus_raw / count)
gen_bonus_raw = min(2 * (generation - 1), 30)
```

The two floors are **not** interchangeable with one combined floor — the combined form reads
1 point high wherever both terms leave a fraction (2 of 3 traits at generation 2 scores 47,
not 48). Reaches exactly 100 at full match and generation ≥ 16. Returned encrypted.

### Rarity roll

Rolled inside `breed_v5` and packed into the **existing** revealed `u32` mask, keeping the proven
2-tuple circuit output.

```
mask = petal + color*256 + leaf*65536 + stem*2^24 + tier*2^19
```

**Bits 19–21, not 27–29.** The live Arcium output path truncates a revealed `u32` at ~27 bits, so
a tier packed at 27–29 read back as **0** on-chain while every other field in the same word landed
correctly. Bits 19–21 sit below that cliff. The callback unpacks `(mask >> 19) & 0x7` into
`FlowerRecord.rarity` and stores a rarity-**stripped** mask, so the frontend's class decoder never
sees those bits.

Lineage lowers each boundary, so a better line clears each tier more often:

```
public_lift = (parent_a_rarity + parent_b_rarity) * 4 + min(generation, 10) * 1   // 0..=50
env_lift    = ((light + water + soil) / 3) / 64                                    // 0..=3
lift        = public_lift + env_lift                                               // 0..=53

b_uncommon  = 115 - lift
b_rare      = 192 - lift
b_epic      = 230 - lift/4
b_legendary = 251 - lift/8

tier = 1 + Σ [roll >= b]      via branchless carry: (r + 256 - b) / 256
```

At lift 0 this is 44.92 / 30.08 / 14.84 / 8.20 / 1.95 % — but **lift 0 is not reachable in
normal play**: every ranked flower has `rarity >= 1` and every offspring has `generation >= 1`, so
two Common parents at generation 1 already sit at lift 9. The published 45/30/15/8/2 curve is a
reference point, not the distribution players see.

The exception is production's legacy stock: 768 hybrids bred before the rarity roll shipped carry
`rarity == 0`, so a cross of two of them reaches lift 1. Those are also the flowers that lose every
rarity tiebreak, so the lowest-lift crosses are made from the least competitive parents.

`env_lift` is quantised to **four** levels
on purpose: the tier is a revealed output, so any dependence on the secret environment dial is a
statistical channel. Four levels needs ~10⁴ breeds against identical public parents to distinguish,
which `MAX_BREEDS_PER_ROUND` puts out of reach. **Do not widen it.**

`rarity == 0` means *unranked* — a legacy hybrid bred before the roll shipped, or one whose
callback never landed. It loses every rarity tiebreak.

### Mutant / Soil — "Candidate C"

`breed_v3` computed `mutation_affinity = (rand_mut + soil) / 2`, and the trait reads that value's
low bit. That combination **provably discards soil**: the result is odd iff `(rand_mut + soil) % 4`
lands in {2,3}, and because `rand_mut` is a uniform `u8` (256 = 4 × 64) its residues mod 4 are
exactly uniform, so adding any constant soil merely permutes them. **P(Mutant) was exactly 0.5 for
all 256 soil values** — verified by brute force over the whole 256×256 space. Soil entered at bit 0
of the sum and the `/2` threw that bit away before the trait ever looked at it.

`breed_v5` gates the parity bit on a direct comparison instead:

```
add              = soil / 8
mutant_threshold = 4 + add
mutant_bit       = (rand_gate < mutant_threshold) ? 1 : 0

mutation_magnitude = (rand_mag + soil) / 2
mutation_affinity  = (mutation_magnitude / 2) * 2 + mutant_bit
```

```
P(Mutant) = (4 + soil/8) / 256
  soil   0 →  1.563 %      soil 128 →  7.813 %      soil 255 → 13.672 %
```

An ~8.8× lever end to end. The **predicate was deliberately not changed** — `trait_satisfied` is
shared with `score_entry_v2` and `private_hint`, so touching it would change those circuits'
bytecode too. The fix lives entirely inside `breed`.

Guarded by `tools/soil-mutant-difftest` (7 tests, both repos).

### Target-trait selection, and the Part B damping gate

`open_round` (**byte-identical in both repos**):

```rust
entropy = SHA-256(slot ‖ timestamp ‖ round_id)          // 32 bytes; only 6 are consumed
count   = TARGET_TRAIT_MIN + entropy[0] % 3             // 2..=4

include_mutant = entropy[5] * 255 < weight * 256        // the Part B gate
pool = [0..10) minus (Mutant if !include_mutant)        // 10 or 9 entries

for k in 0..count:                                      // partial Fisher-Yates
    swap_with = k + entropy[k+1] % (pool_len - k)
    swap(pool[k], pool[swap_with]); targets[k] = pool[k]
```

Entropy budget: `entropy[0]` for the count, `entropy[1..=4]` for the swaps. **Bytes 5–31 are
free**, which is what lets the gate be added without perturbing the swap stream.

**Why gate the pool rather than weight the sampling.** Duplicating non-Mutant ids to bias the draw
breaks the no-duplicate-targets invariant — partial Fisher-Yates over a multiset can return the
same id twice, and duplicate targets would double-count in `score_entry_v2`'s matched-trait loop
and distort every score in the round. Gating the pool keeps Fisher-Yates exactly as it is and only
changes what it draws from, so distinctness is preserved structurally.

**Provably a no-op at weight 255.** The gate reads only `entropy[5]`; at `weight = 255` the right
side is 65 280 while the left peaks at 255 × 255 = 65 025, so it holds for **all 256** values of
that byte. Both halves are enumerated exhaustively in `open_round.rs`'s test module against a
verbatim transcription of the pre-weighting selection.

**Auto-restore.** `effective_mutant_weight(now)` returns 255 once `now >= restore_ts`, whatever
`mutant_weight` says — the damping fails **open**, so forgetting to reset it restores uniform
selection on schedule. `restore_ts = 0` (the zero-filled default) is already in the past, which is
also what makes an un-migrated config safe.

> ⚠️ **Known modulo bias — pre-existing, and deliberately preserved.** The selection is *not*
> uniform over the ten traits and never has been. `entropy[k+1] % remaining` with `remaining` ∈
> {10, 9, 8, 7} is biased because 256 is not a multiple of any of them, so high-bucket ids are
> slightly under-drawn. Mutant (id 8) is one of them: the exact unweighted rate is **0.19635** at
> count 2 and **0.29681** at count 3, against the 0.2 / 0.3 an unbiased draw would give — about
> 1.5 % relative. This predates the damping. Correcting it would break the byte-identity guarantee
> above, which is worth more than 1.5 % of accuracy on a cosmetic damper. Any test asserting a
> closed form must measure the real baseline rather than assume `count/10`.

---

## 6. Known divergences: production vs dev

### Instructions

| | production | dev |
|---|---|---|
| `migrate_entry` | ✅ | ❌ — dev's entries have no `rarity_snapshot` to migrate |
| `init_reveal_top3_v2_comp_def`, `queue_reveal_top3_v2`, `reveal_top3_v2_callback` | ❌ | ✅ |

### Account layout

- **`CompetitionEntry`** — production carries a trailing `rarity_snapshot: u8` (175 B), taken at
  submission so `reveal_top3_v5`'s tiebreak needs *n* remaining accounts instead of *2n*. Dev has
  no such field (174 B) and reads rarity at reveal time via `FLOWER_RARITY_OFFSET`.
- **`GameConfig`** — production **158 B** (migrated, `mutant_weight = 255`, `restore_ts = 0`);
  dev **149 B**.

### ⚠️ Deployment state — the most important divergence

**Dev's source contains Part B but its deployed program does not.** Dev has `set_mutant_weight`,
the 158-byte `GameConfig` and the weighting gate committed (`5dac9b6`), but that binary was never
deployed. Its on-chain config is still 149 bytes, and dev has opened 38 rounds since — which would
be impossible if the deployed struct were 158, because `open_round` takes a typed
`Account<GameConfig>`.

**Therefore, before dev is next deployed:** `migrate_config` must run immediately after the
upgrade, or dev's whole instruction surface breaks in the interval.

Production is fully deployed and migrated: `breed_v5` live and executed, config migrated,
`mutant_weight = 255` (uniform — damping available but not engaged).

### Circuit drift — dev only

Dev's `encrypted-ixs/src/lib.rs` carries an **undeployed** refactor that extracted the duplicated
`trait_satisfied` closures into a shared free function. Its source comment claims the bytecode is
byte-identical; the build artifacts say otherwise:

| circuit | dev deployed | dev local build | production |
|---|---|---|---|
| `score_entry_v2` | 163 085 B | **162 805 B** | 163 085 B (source == deployed) |
| `private_hint` | 63 099 B | **62 783 B** | 63 099 B (source == deployed) |

Both repos are on `arcis =0.14.1` with identical lockfiles, and both builds are current with their
sources. **Consequence:** dev's current source does not reproduce dev's deployed bytes for those
two circuits. Any port from dev must take **only the intended hunks**, never the whole file — which
is why production's `breed_v5` was ported as two hunks and verified by rebuilding
`score_entry_v2`/`private_hint` to their exact deployed hashes.

`scripts/auto-cycle.ts`'s byte-freshness pre-flight reports both as stale on dev today.

### Circuit binaries

Production's `breed_v5` compiles to **282 005 B** against dev's **281 981 B** — 24 bytes larger,
3 more *public* gates. The circuit **bodies are character-identical** and the `.idarc` argument
signatures match; every MPC cost metric (arith/bit singlets and triples, `da_bits`, depth, network
size) is identical. The difference is surrounding-crate codegen, not behaviour.

### Constants

Only two differ, both structural: `ENTRY_FLOWER_OFFSET` (production only) and `TOP3_V2_SEED`
(dev only). Every gameplay constant is identical.

### Errors

Identical — 57 variants, 6000–6056, same order, same messages.

---

## Appendix — invariants worth not breaking

1. **A comp-def stores its circuit's argument signature and can never be re-uploaded in place.**
   Any change to a circuit's parameters needs a new circuit **name**, which moves its offset, which
   moves the callback's Anchor discriminator. Six sites move together: `comp_def_offset`, the
   callback fn and its generated types, the `init`/`queue`/`callback` account macros, the uploader's
   circuit map, and `auto-cycle.ts`'s pre-flight guard.
2. **Append-only account layouts.** New fields go last. A field inserted above an existing one
   silently corrupts every account written by the old code.
3. **Every appended field's zero value must be safe** — or `migrate_*` must stamp it explicitly.
   `mutant_weight` is the counter-example: zero reads as "never target Mutant", so `migrate_config`
   writes 255 over byte 149 by offset.
4. **Sort entry pubkeys byte-wise, never by base58 text.** `Pubkey` compares as `[u8; 32]`; a key
   with a leading zero byte yields a 43-character base58 string that sorts last as text but first as
   bytes. This bites ~1 in 256 keys, so it looks intermittent.
5. **`trait_satisfied` is shared bytecode.** Touching it changes `score_entry_v2` *and*
   `private_hint`, both of which are deployed and finalized.
6. **The UI must mirror on-chain constraints, not guess at them.** The `can*` predicates exist so a
   button whose transaction is certain to be rejected is never offered.
