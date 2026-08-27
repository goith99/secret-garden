use anchor_lang::prelude::*;

use crate::constants::{
    ENCRYPTED_GENOME_LEN, ENCRYPTION_METADATA_LEN, ENTRY_SCORE_LEN, ENTRY_SCORE_NONCE_LEN,
    FLOWER_RARITY_OFFSET, GENOME_COMMITMENT_LEN, HINT_CIPHERTEXT_LEN, HINT_ENCRYPTION_KEY_LEN,
    HINT_NONCE_LEN,
};

/// Singleton game configuration. PDA seeds: `[b"config"]`.
#[account]
#[derive(InitSpace)]
pub struct GameConfig {
    /// Wallet allowed to administer the game (set at initialization).
    pub authority: Pubkey,
    /// Global kill-switch; when `true`, player-facing instructions are rejected.
    pub paused: bool,
    /// Current game round counter (advanced by later stages).
    pub current_round: u64,
    /// Number of starter flowers granted by `claim_starters`.
    pub starter_count: u8,
    /// On-chain schema version (see `PROGRAM_VERSION`).
    pub version: u8,
    /// PDA bump.
    pub bump: u8,

    // --- Multi-operator support (appended; existing field offsets unchanged so configs
    //     created before this change stay deserializable — see `migrate_config`) ---
    /// Up to three additional operator wallets allowed to run rounds (open/close/score/
    /// reveal/finalize). Only the first `operator_count` slots are active; the rest are
    /// `Pubkey::default()`. Operators CANNOT add/remove operators, pause, or upgrade.
    pub operators: [Pubkey; 3],
    /// Number of active entries in `operators` (0..=3).
    pub operator_count: u8,

    // --- Mutant target weighting (appended; existing field offsets unchanged so configs
    //     created before this change stay deserializable — see `migrate_config`) ---
    /// How often `open_round` is allowed to put Mutant (`TRAIT_ID_MUTANT`) in the trait pool,
    /// as a fraction of `MUTANT_WEIGHT_UNIFORM` (255 = always, 0 = never). Only the POOL is
    /// affected; nothing about scoring, entries or flowers reads this.
    ///
    /// This exists because `breed_v5` makes Mutant genuinely scarce to breed while flowers
    /// bred under the old flat-50% formula keep their old odds — so until the post-cutover
    /// population is large, a Mutant-target round rewards legacy stock. Mutant is the ONLY
    /// trait where the two generations differ (`mutation_affinity` is read in exactly one
    /// place: `trait_satisfied`'s arm 8), so damping how often it is targeted damps the whole
    /// effect proportionally.
    ///
    /// Zero-filled to 0 by `migrate_config`'s `resize`, which would otherwise read as "never
    /// target Mutant" — the exact opposite of a safe default. Two independent things prevent
    /// that: `migrate_config` writes 255 over the byte explicitly, and `restore_ts` zero-fills
    /// to 0, which `effective_mutant_weight` reads as "already restored". Either alone is
    /// sufficient; both are present on purpose.
    pub mutant_weight: u8,
    /// Unix timestamp at (and after) which `mutant_weight` is ignored and selection returns to
    /// uniform, so forgetting to reset the weight cannot quietly distort rounds forever. A 0
    /// (the zero-filled default) is already in the past, so an un-configured config is uniform.
    pub restore_ts: i64,
}

impl GameConfig {
    /// The Mutant weight that `open_round` should actually use at time `now`.
    ///
    /// Returns `MUTANT_WEIGHT_UNIFORM` — i.e. no reduction — once `now` has reached
    /// `restore_ts`, whatever `mutant_weight` says. The weighting is a temporary measure
    /// while the post-`breed_v5` flower population builds up, so it fails OPEN: an operator
    /// who sets a weight and then forgets about it gets uniform selection back on schedule
    /// rather than a permanently distorted trait pool. Setting `restore_ts` into the past
    /// (0 included) is therefore also the way to switch the weighting off entirely.
    ///
    /// Pure, so it is unit-testable without a `Clock` or an Anchor context.
    pub fn effective_mutant_weight(&self, now: i64) -> u8 {
        if now >= self.restore_ts {
            crate::constants::MUTANT_WEIGHT_UNIFORM
        } else {
            self.mutant_weight
        }
    }
}

/// True if `signer` is the config authority or one of the active operators. Authority has
/// every permission; operators are limited to the round-running instructions that call this.
/// Authority-only instructions (set_paused, migrate_config, add/remove_operator) must NOT
/// use this — they check `config.authority` directly (via `has_one`).
pub fn is_operator_or_authority(config: &GameConfig, signer: &Pubkey) -> bool {
    if *signer == config.authority {
        return true;
    }
    config.operators[..config.operator_count as usize]
        .iter()
        .any(|op| op == signer)
}

/// Reads `FlowerRecord::rarity` out of a raw `AccountInfo`, for the reveal queue
/// instructions' `reveal_top3_v5` composite ranking key.
///
/// TRUSTLESS, NOT OPERATOR-SUPPLIED. `expected` is the `flower_record` pubkey stored on the
/// CompetitionEntry being ranked, so the caller cannot substitute a different (higher-rarity)
/// flower for someone else's entry: the key must match the one the entry itself recorded at
/// submission. Ownership and the account discriminator are both checked, so a look-alike
/// account of another type is rejected too.
///
/// Reads ONE byte rather than deserialising. A FlowerRecord is 529 bytes, 320 of which are
/// the encrypted genome, and a full-round reveal ranks up to 16 of them — deserialising each
/// one would burn compute to obtain a single `u8` that sits at a fixed offset.
pub fn read_flower_rarity(info: &AccountInfo, expected: &Pubkey) -> Result<u8> {
    require_keys_eq!(
        *info.key,
        *expected,
        crate::error::SecretGardenError::FlowerNotOwned
    );
    require_keys_eq!(
        *info.owner,
        crate::ID,
        crate::error::SecretGardenError::FlowerNotOwned
    );
    let data = info.try_borrow_data()?;
    require!(
        data.len() > FLOWER_RARITY_OFFSET,
        crate::error::SecretGardenError::FlowerNotOwned
    );
    require!(
        &data[..8] == FlowerRecord::DISCRIMINATOR,
        crate::error::SecretGardenError::FlowerNotOwned
    );
    Ok(data[FLOWER_RARITY_OFFSET])
}

/// Per-wallet player profile. PDA seeds: `[b"profile", owner]`.
#[account]
#[derive(InitSpace)]
pub struct PlayerProfile {
    /// Wallet that owns this profile.
    pub owner: Pubkey,
    /// Whether this wallet has already claimed its starter flowers.
    pub starter_claimed: bool,
    /// Total flowers owned (6 immediately after claiming starters).
    pub total_flowers: u16,
    /// Total successful crosses performed (Stage 2+).
    pub total_crosses: u16,
    /// Breeding attempts used in the current day window (Stage 2+).
    pub daily_attempts: u8,
    /// Final submissions made to a challenge (Stage 4+).
    pub final_submissions: u8,
    /// Unix timestamp the profile was created.
    pub created_at: i64,
    /// Breeding experiments currently in flight. Incremented by `start_breeding`
    /// (Stage 3A); decremented when an experiment resolves to Completed/Expired
    /// (Stage 3B's callback / cancel instructions).
    pub active_experiment_count: u32,
    /// Monotonic count of experiments ever started; never decremented. Used as the
    /// `experiment_index` nonce in the `Experiment` PDA so a wallet can run many
    /// concurrent experiments without seed collisions.
    pub total_experiments: u32,
    /// Monotonic next FlowerRecord index (PDA nonce). Starters occupy 0..=5, so this is
    /// `STARTER_COUNT` after claiming. A dedicated `u32` (rather than the `u16`
    /// `total_flowers`) keeps the flower PDA seed a clean 4-byte index and avoids a cast
    /// in the seed (which the IDL builder rejects).
    pub next_flower_index: u32,
    /// PDA bump.
    pub bump: u8,

    // --- Stage 5D: per-round breeding limit (appended; existing field offsets unchanged
    //     so accounts created before this stage stay deserializable — see migration note) ---
    /// `start_breeding` attempts used in the round identified by `last_breed_round`
    /// (0..=`MAX_BREEDS_PER_ROUND`). Reset to 0 lazily on the first breed of a new round.
    pub breeds_this_round: u8,
    /// The `GameConfig::current_round` (truncated to `u32`) the player last bred in. When
    /// this differs from the live `current_round`, `breeds_this_round` is stale and resets.
    pub last_breed_round: u32,
}

impl PlayerProfile {
    /// Enforce the per-round breeding limit and record this attempt. Pure (no Anchor
    /// context), so it is unit-testable in isolation — the surrounding `start_breeding`
    /// body that calls it is unreachable under bankrun (its Arcium accounts don't exist).
    ///
    /// `current_round` is `GameConfig::current_round` truncated to `u32`; round ids are
    /// monotonic and tiny, so the truncation cannot collide in any realistic deployment.
    ///
    /// Lazy reset: the first breed in a round the player hasn't bred in this cycle zeroes
    /// the counter, so no operator action is needed when a new round opens.
    pub fn register_breed_attempt(&mut self, current_round: u32) -> Result<()> {
        if self.last_breed_round != current_round {
            self.breeds_this_round = 0;
            self.last_breed_round = current_round;
        }
        require!(
            self.breeds_this_round < crate::constants::MAX_BREEDS_PER_ROUND,
            crate::error::SecretGardenError::BreedingLimitReached
        );
        self.breeds_this_round += 1;
        Ok(())
    }

    /// V1 hybrid collection cap. `total_flowers - STARTER_COUNT` is the live hybrid count
    /// (Option A accounting — the `STARTER_COUNT` starters are permanent, and every hybrid
    /// create/destroy adjusts `total_flowers`). Returns `Err(CollectionFull)` once the player
    /// already holds `FLOWER_COLLECTION_CAP` hybrids. `saturating_sub` guards the u16
    /// subtraction (a pre-claim profile with `total_flowers < STARTER_COUNT` yields 0, which
    /// is always under the cap — and you cannot breed before claiming starters anyway).
    ///
    /// Pure (no Anchor context), so it is unit-testable in isolation like
    /// `register_breed_attempt`; the `start_breeding` body that calls it is unreachable under
    /// bankrun (its Arcium accounts don't exist) and only fully runs against a live cluster.
    pub fn check_collection_cap(&self) -> Result<()> {
        let live_hybrids = self
            .total_flowers
            .saturating_sub(crate::constants::STARTER_COUNT as u16);
        require!(
            live_hybrids < crate::constants::FLOWER_COLLECTION_CAP,
            crate::error::SecretGardenError::CollectionFull
        );
        Ok(())
    }
}

/// One record per flower a wallet owns. PDA seeds: `[b"flower", owner, flower_index_le]`.
///
/// NOTE: Stage 1 deliberately stores NO genome / commitment / ciphertext. Stage 3 will
/// realloc this account to append encrypted-genome data once the Arcium circuit fixes
/// the ciphertext size. `genome_status` already distinguishes Starter (0) from
/// Encrypted (1) so client reload logic remains stable across stages.
#[account]
#[derive(InitSpace)]
pub struct FlowerRecord {
    /// Wallet that owns this flower.
    pub owner: Pubkey,
    /// Index of this flower within the owner's collection (also a PDA seed).
    pub flower_index: u32,
    /// Cosmetic species id used by the client renderer.
    pub visual_species_id: u8,
    /// Breeding generation (0 for starters).
    pub generation: u16,
    /// Rarity tier (see `RARITY_*`).
    pub rarity: u8,
    /// Genetic stability on a 0..=100 scale (100 for starters).
    pub stability: u8,
    /// Bitmask of publicly revealed cosmetic traits (see `TRAIT_*`).
    pub revealed_trait_mask: u32,
    /// First parent flower (default/zero for starters).
    pub parent_a: Pubkey,
    /// Second parent flower (default/zero for starters).
    pub parent_b: Pubkey,
    /// Genome lifecycle marker (see `GENOME_STATUS_*`).
    pub genome_status: u8,
    /// Source breeding experiment (default/zero for starters).
    pub source_experiment: Pubkey,
    /// Lifecycle status (see `FLOWER_STATUS_*`).
    pub status: u8,
    /// Unix timestamp the flower was created.
    pub created_at: i64,
    /// PDA bump.
    pub bump: u8,

    // --- Stage 3A: encrypted genome (appended; zeroed for starters) ---
    // These trail the original Stage 1/2 layout so existing field offsets are
    // unchanged. Populated by Stage 3B's breeding callback for Encrypted flowers.
    /// Hash commitment to `encrypted_genome` (zero until a genome is attached).
    pub genome_commitment: [u8; GENOME_COMMITMENT_LEN],
    /// `Enc<Mxe, Genome>` ciphertext: 10 scalars * 32 bytes (see ENCRYPTED_GENOME_LEN).
    pub encrypted_genome: [u8; ENCRYPTED_GENOME_LEN],
    /// MXE nonce for `encrypted_genome` (little-endian u128 = 16 bytes).
    pub encryption_metadata: [u8; ENCRYPTION_METADATA_LEN],
    /// Appended LAST so every existing field offset is unchanged — but the account still
    /// grows by one byte, so a pre-5E FlowerRecord (528 bytes) cannot be read as this struct
    /// (529 bytes) until `migrate_flower` reallocs it. See that instruction.
    pub times_bred_as_parent: u8,
}

impl FlowerRecord {
    /// Stage 5E per-flower breeding-parent budget. Returns `Err(FlowerParentLimitReached)`
    /// once this flower has already been a parent `MAX_BREEDS_AS_PARENT` times, and
    /// otherwise spends one use.
    ///
    /// The spend happens at QUEUE time (`start_breeding`), not in the callback: a callback
    /// can fail, expire, or never arrive, and the parent is genuinely committed (Locked)
    /// from the queue onward. It is deliberately NOT refunded by
    /// `cancel_expired_experiment` — refunding would make the cap gameable by queueing and
    /// immediately cancelling.
    ///
    /// The cap is permanent and per flower, unlike `MAX_BREEDS_PER_ROUND`, which is a
    /// per-player budget that resets each round. An exhausted flower stays fully usable for
    /// everything else — submit, score, hint, release, close.
    ///
    /// Pure (no Anchor context), so it is unit-testable in isolation like
    /// `register_breed_attempt` and `check_collection_cap`; the `start_breeding` body that
    /// calls it is unreachable under bankrun (its Arcium accounts don't exist) and only
    /// fully runs against a live cluster.
    pub fn register_breed_as_parent(&mut self) -> Result<()> {
        require!(
            self.times_bred_as_parent < crate::constants::MAX_BREEDS_AS_PARENT,
            crate::error::SecretGardenError::FlowerParentLimitReached
        );
        self.times_bred_as_parent = self.times_bred_as_parent.saturating_add(1);
        Ok(())
    }

    /// Read-only form of the same check, for callers that must validate BOTH parents before
    /// spending either one's budget (so a rejected breed consumes nothing).
    pub fn check_breed_as_parent(&self) -> Result<()> {
        require!(
            self.times_bred_as_parent < crate::constants::MAX_BREEDS_AS_PARENT,
            crate::error::SecretGardenError::FlowerParentLimitReached
        );
        Ok(())
    }

    /// Remaining breeding uses, for clients rendering "X/3 uses left".
    pub fn breeds_as_parent_remaining(&self) -> u8 {
        crate::constants::MAX_BREEDS_AS_PARENT.saturating_sub(self.times_bred_as_parent)
    }
}

/// A daily competition round. PDA seeds: `[b"round", round_id_le]`.
#[account]
#[derive(InitSpace)]
pub struct CompetitionRound {
    /// Monotonic round number (== `GameConfig::current_round` at open time).
    pub round_id: u64,
    /// Lifecycle status (see `ROUND_STATUS_*`).
    pub status: u8,
    /// Unix timestamp the round opened.
    pub start_time: i64,
    /// Submission deadline, snapped to the daily `ROUND_ANCHOR_UTC_SECONDS` anchor by
    /// `round_end_time` — NOT a fixed offset from `start_time`.
    pub end_time: i64,
    /// Maximum number of entries allowed (see `MAX_PARTICIPANTS`).
    pub max_participants: u16,
    /// Number of entries submitted so far.
    pub participant_count: u16,
    /// Operator that opened the round; the only signer allowed to close/finalize it.
    pub authority: Pubkey,
    /// PDA bump.
    pub bump: u8,

    // --- Stage 4A: scoring (appended; existing Stage 2 offsets unchanged) ---
    /// Public target trait ids for this round (see `TRAIT_TABLE`); only the first
    /// `target_trait_count` slots are active. Generated at `open_round` time.
    pub target_traits: [u8; 4],
    /// Number of active trait slots (`TARGET_TRAIT_MIN..=TARGET_TRAIT_MAX`).
    pub target_trait_count: u8,
    /// Winner `CompetitionEntry` pubkeys, `Pubkey::default()` until Stage 4B's
    /// `reveal_top3` callback fills them.
    pub top1: Pubkey,
    pub top2: Pubkey,
    pub top3: Pubkey,
    /// False until Stage 4B finalizes results.
    pub scoring_revealed: bool,
    /// Count of entries scored so far. Incremented by Stage 4B's `score_entry` callback
    /// (not written in Stage 4A); gates `queue_reveal_top3`.
    pub scored_count: u16,
}

/// A player's entry into a round. PDA seeds: `[b"entry", round, player]`.
///
/// The PDA is unique per (round, player), so the `init` constraint failing on a second
/// submission is itself the duplicate-entry guard — no manual check is needed.
#[account]
#[derive(InitSpace)]
pub struct CompetitionEntry {
    /// The `CompetitionRound` this entry belongs to.
    pub round: Pubkey,
    /// The player that submitted the entry.
    pub player: Pubkey,
    /// The `FlowerRecord` submitted to the round.
    pub flower_record: Pubkey,
    /// Unix timestamp the entry was submitted.
    pub submitted_at: i64,
    /// Entry status (see `ENTRY_STATUS_*`). Stage 2 only sets `SUBMITTED`.
    pub status: u8,
    /// PDA bump.
    pub bump: u8,

    // --- Stage 4B: scoring (appended; existing Stage 2 offsets unchanged) ---
    /// `Enc<Mxe, u8>` score ciphertext (zero until scored). Read in-place by
    /// `reveal_top3` via `ArgBuilder::account()` — the integrity fix that stops callers
    /// from supplying fabricated scores.
    pub encrypted_score: [u8; ENTRY_SCORE_LEN],
    /// MXE nonce for `encrypted_score` (little-endian u128).
    pub score_nonce: [u8; ENTRY_SCORE_NONCE_LEN],
    /// True once `score_entry_callback` has persisted this entry's score. Gates re-queuing
    /// (`queue_score_entry` requires `scored == false`) and makes the callback idempotent.
    pub scored: bool,
    /// Failure code (0 = none); set by `score_entry_callback` on a failed computation.
    pub score_error_code: u16,

    // --- Stage 5A: scoring recovery (appended; Stage 4B offsets — incl.
    //     ENTRY_SCORE_OFFSET — are unchanged because these trail every prior field) ---
    /// True while a scoring computation is in flight. Set by `queue_score_entry`; cleared
    /// by `score_entry_callback` (on success OR failure) and by `cancel_stuck_score`. Acts
    /// as the "currently queued" state: it blocks a second concurrent queue and is what
    /// `cancel_stuck_score` resets so a stuck (never-callback'd) entry becomes re-queueable.
    pub score_queued: bool,
    /// Unix timestamp of the most recent `queue_score_entry` for this entry (0 until first
    /// queued). Drives the `cancel_stuck_score` timeout.
    pub queued_at: i64,

    // --- Stage 5E: rarity snapshot (appended LAST; every prior offset is unchanged) ---
    /// The submitted flower's `rarity`, copied here by `submit_entry` at the moment of
    /// submission, for `reveal_top3_v5`'s composite ranking key (`score * 8 + rarity`).
    ///
    /// WHY SNAPSHOT RATHER THAN READ THE FLOWER AT REVEAL TIME. The reveal used to take a
    /// SECOND run of remaining accounts — the FlowerRecord behind every entry — purely to
    /// read this one byte. At `MAX_SHARD_SIZE` (13) that is 26 account references, and the
    /// queue transaction reached 1580 bytes against Solana's 1232-byte packet limit, so the
    /// largest shards became unsendable. Shrinking the shard was not available either: the
    /// `MAX_TIER1_WINNERS <= MAX_SHARDS * MAX_SHARD_SIZE` assert in `constants.rs` fails at
    /// any smaller shard size, and the `MAX_FINALISTS <= MAX_REVEAL_ACCOUNT_REFS` assert
    /// caps `MAX_SHARDS` at 4, so the bracket cannot absorb the extra shards. Carrying the
    /// byte on the entry removes the second account run outright: the reveal already
    /// deserializes every entry, so rarity now costs ZERO additional accounts.
    ///
    /// EQUALLY TRUSTLESS, AND WRITE-ONCE. `submit_entry` reads it from a typed, validated
    /// `Account<FlowerRecord>` that Anchor has already proven is program-owned with the
    /// right discriminator, and which the handler checks is Active and owned by the signer —
    /// the same guarantees `read_flower_rarity` reconstructs by hand from a raw AccountInfo.
    /// The entry is created with `init` and no instruction ever rewrites this field, so it
    /// cannot be re-snapshotted later. Nothing can change the value behind its back either:
    /// `rarity` is only ever written when a flower is CREATED (starters in `claim_starters`,
    /// offspring in `start_breeding`/`breed_v5_callback`) and never mutated afterwards, and
    /// a Submitted flower cannot be bred (breeding requires Active), released (that requires
    /// the round Finalized) or closed while the round is live.
    ///
    /// 0 for entries created before this field existed; `migrate_entry` backfills them.
    pub rarity_snapshot: u8,
}

/// A breeding experiment: one queued (and later resolved) MPC computation.
/// PDA seeds: `[b"experiment", owner, experiment_index_le]` where `experiment_index`
/// is `PlayerProfile::total_experiments` at creation time.
#[account]
#[derive(InitSpace)]
pub struct Experiment {
    /// Wallet that started the experiment.
    pub owner: Pubkey,
    /// First parent flower.
    pub parent_a: Pubkey,
    /// Second parent flower.
    pub parent_b: Pubkey,
    /// Arcium computation offset for this experiment's queued computation.
    pub computation_offset: u64,
    /// Lifecycle status (see `EXPERIMENT_STATUS_*`). Stage 3A only sets `QUEUED`.
    pub status: u8,
    /// Offspring flower, written by Stage 3B's callback (`Pubkey::default()` until then).
    pub result_flower: Pubkey,
    /// Unix timestamp the experiment was created.
    pub created_at: i64,
    /// Unix timestamp of the last status change.
    pub updated_at: i64,
    /// Failure code (0 = none); set by Stage 3B on failure/expiry.
    pub error_code: u16,
    /// Whether Stage 3B's callback has already processed this experiment.
    pub callback_processed: bool,
    /// PDA bump.
    pub bump: u8,
}

/// Per-player Private Hint result. PDA seeds: `[b"hint", player]` — exactly ONE account per
/// player, OVERWRITTEN on each new `queue_private_hint` (hints are transient/informational,
/// so no history is kept on-chain and rent stays bounded to one small account per player).
///
/// Created (or reset to `ready = false`) at queue time; the sealed ciphertext is written by
/// `private_hint_callback`. `ready` is the "no hint yet" vs "hint ready" flag: a freshly
/// queued (or never-computed) result reads `ready == false`, so a client never mistakes a
/// stale/blank ciphertext for a fresh answer. The ciphertext is `Enc<Shared, u8>` sealed to
/// this `player`'s x25519 key; only they can decrypt it (see the `private_hint` circuit).
#[account]
#[derive(InitSpace)]
pub struct HintResult {
    /// The player this hint belongs to (also the PDA seed). Only this wallet's sealing key
    /// can decrypt `ciphertext`.
    pub player: Pubkey,
    /// The `round_id` whose target traits the latest hint was computed against. Lets a client
    /// detect a hint left over from a previous round.
    pub round_id: u64,
    /// Number of meaningful low bits in the decrypted bitmask (== the round's
    /// `target_trait_count` at request time). Public convenience; bits `>= count` are 0.
    pub target_trait_count: u8,
    /// `false` until `private_hint_callback` writes a fresh sealed result; reset to `false`
    /// by every new `queue_private_hint`. Distinguishes "no hint yet" from "hint ready".
    pub ready: bool,
    /// x25519 encryption key from the sealed output (`SharedEncryptedStruct::encryption_key`);
    /// the client combines it with its own private key to derive the decryption shared secret.
    pub encryption_key: [u8; HINT_ENCRYPTION_KEY_LEN],
    /// Sealing nonce (little-endian u128) for `ciphertext`.
    pub nonce: [u8; HINT_NONCE_LEN],
    /// The sealed 1-byte bitmask (`Enc<Shared, u8>` = 1 scalar * 32 bytes). Meaningless until
    /// `ready == true`.
    pub ciphertext: [u8; HINT_CIPHERTEXT_LEN],
    /// Unix timestamp the latest hint was computed (0 until the first callback lands).
    pub computed_at: i64,
    /// PDA bump.
    pub bump: u8,
}

/// Result record for a `reveal_top3_v3` computation. Used BOTH by the standalone
/// differential-test path (one per round, seeded `[TOP3_V3_SEED, round]`) and, crucially, by
/// the BRACKET: every shard/semifinal/final reveal lands its raw output in one of these,
/// seeded `[SHARD_RESULT_SEED, round, shard_index]`.
///
/// WHY A SEPARATE ACCOUNT rather than writing `CompetitionRound`. The v3 callback deliberately
/// does NOT touch `top1/top2/top3` or `scoring_revealed`. For the bracket that is essential —
/// a shard reveal ranks only its own slice, so writing the round's winners from it would be
/// wrong; `apply_bracket_result` is what finally writes the round, once, from the final reveal.
#[account]
#[derive(InitSpace)]
pub struct RevealTop3V3Result {
    /// The round this result belongs to (also the PDA seed).
    pub round: Pubkey,
    /// `false` until `reveal_top3_v3_callback` lands; reset by every new queue.
    pub ready: bool,
    /// Winning SLOT indices, exactly as revealed by the circuit.
    pub slot1: u16,
    pub slot2: u16,
    pub slot3: u16,
    /// The three revealed scores, in rank order.
    pub score1: u8,
    pub score2: u8,
    pub score3: u8,
    /// Failure code (0 = none) if the computation aborted.
    pub error_code: u16,
    /// PDA bump.
    pub bump: u8,
    /// The `generation` of the bracket/tier1 state this result was queued under, stamped at
    /// queue time and NEVER touched by the callback. `collect_*`/`apply` require it to equal
    /// the state's CURRENT generation, so a result computed under an earlier partition (before
    /// an `init_bracket`/`init_tier1_bracket` re-init) can no longer be reused to place a
    /// winner that was never actually ranked against its real shard-mates. (APPENDED field —
    /// old finalized result accounts are never re-read, so this needs no migration.)
    pub generation: u32,
}

/// Per-round bracket tracker. PDA seeds: `[BRACKET_SEED, round]`. ADDITIVE.
///
/// WHY THIS EXISTS. A single Arcium computation may reference at most
/// `MAX_REVEAL_ACCOUNT_REFS` (14) distinct accounts in its argument list, so a round
/// larger than that cannot be revealed by one `reveal_top3_v3` call. This account tracks a
/// two-level reveal: several shard reveals, then one final reveal over the shard winners.
///
/// THE PARTITION IS PINNED HERE, NOT TRUSTED. `init_bracket` records `shard_sizes` and
/// `shard_bounds` (the FIRST entry pubkey of each shard) once. Every `queue_shard_reveal`
/// then re-derives nothing — it VERIFIES that the supplied entry accounts are strictly
/// ascending by pubkey, start exactly at this shard's bound, and stay below the next
/// shard's bound. Strict ordering + disjoint declared intervals + `sum(shard_sizes) ==
/// participant_count` proves the shards are a partition of exactly the round's entries,
/// so the operator cannot drop, duplicate or smuggle in an entry.
///
/// `CompetitionRound::top1/2/3` and `scoring_revealed` stay UNTOUCHED until
/// `apply_bracket_result` runs at the very end, so anything reading a round today sees
/// either "not revealed" or the final answer — never a half-finished bracket.
#[account]
#[derive(InitSpace)]
pub struct BracketState {
    /// The round this bracket belongs to (also the PDA seed).
    pub round: Pubkey,
    /// Number of shards in use (1..=`MAX_SHARDS`).
    pub shard_count: u8,
    /// Entries in each shard; only the first `shard_count` slots are meaningful.
    pub shard_sizes: [u8; crate::constants::MAX_SHARDS],
    /// FIRST entry pubkey of each shard, ascending. Defines the partition boundaries.
    pub shard_bounds: [Pubkey; crate::constants::MAX_SHARDS],
    /// Bit `k` set once shard `k`'s winners have been collected into `finalists`.
    pub shards_collected: u8,
    /// Shard winners in shard order, then rank order within a shard. Re-sorted into
    /// pubkey-ascending order by `queue_final_reveal`'s caller and verified there.
    pub finalists: [Pubkey; crate::constants::MAX_FINALISTS],
    /// How many slots of `finalists` are filled.
    pub finalist_count: u8,
    /// Set once the final reveal has been queued (blocks a second concurrent queue).
    pub final_queued: bool,
    /// Set by `apply_bracket_result` once the round's top1/2/3 have been written.
    pub applied: bool,
    /// PDA bump.
    pub bump: u8,
    /// Monotonic re-init counter, bumped by EVERY `init_bracket` (and `promote_tier1`) call.
    /// Every shard/semifinal/final `RevealTop3V3Result` is stamped with the generation current
    /// at queue time; `collect_*`/`apply` reject any result whose generation != this. That
    /// makes a re-init (which resets `shards_collected`/`finalists` but leaves the per-shard
    /// result PDAs intact and `ready`) unable to smuggle a stale, differently-partitioned
    /// result back in. `BracketState` persists across re-inits (`init_if_needed`), so a plain
    /// counter strictly increases and never collides. (APPENDED — old brackets are finalized
    /// and never re-read, so no migration is needed.)
    pub generation: u32,
}

impl BracketState {
    /// True once every shard's winners have been collected.
    pub fn all_shards_collected(&self) -> bool {
        let full = if self.shard_count >= 8 {
            u8::MAX
        } else {
            (1u8 << self.shard_count) - 1
        };
        self.shards_collected == full
    }
}

/// Tier-1 tracker for a round too large for one tier of shards. PDA: `[TIER1_SEED, round]`.
/// ADDITIVE — this account simply does not exist for rounds at or under
/// `SINGLE_TIER_CAPACITY`, and its ABSENCE is what selects the original single-tier path.
/// `BracketState` is NOT modified: in two-tier mode its existing `shard_*` fields describe
/// the SEMIFINAL tier, which has exactly the shape it already models.
///
/// ZERO-COPY, and it has to be. At 2,246 bytes a plain `Account<Tier1State>` deserializes
/// onto the 4 KB BPF stack and aborts the program before the handler runs (measured on
/// devnet: "Access violation ... at address 0x0" after 15,259 CU). `AccountLoader` maps the
/// account data in place, so size stops mattering for the stack.
///
/// POD LAYOUT RULES this struct obeys, both enforced by bytemuck's derive at compile time:
///   * no `bool` — `promoted` is a `u8` (0/1), because `bool` is not `Pod`;
///   * NO IMPLICIT PADDING — every field is align-1 (`Pubkey` is `[u8; 32]`, the rest are
///     `u8`/`[u8; N]`), so the struct is align-1 and no padding byte can exist regardless
///     of field order. That is also why `shards_collected` became a `[u8; N]` flag array
///     instead of a `u32` bitmask: a `u32` would force 4-byte alignment and introduce
///     trailing padding, which the safe `Pod` derive rejects.
#[account(zero_copy)]
#[repr(C)]
pub struct Tier1State {
    /// The round this belongs to (also the PDA seed).
    pub round: Pubkey,
    /// First entry pubkey of each tier-1 shard, ascending — the partition boundaries.
    pub shard_bounds: [Pubkey; crate::constants::MAX_TIER1_SHARDS],
    /// Tier-1 winners, kept in ASCENDING PUBKEY ORDER by insertion at collect time.
    ///
    /// Sorting as we go is what lets the semifinal partition be derived and verified BY
    /// INDEX (`winners[start..end]`) rather than trusting operator-declared boundaries.
    pub winners: [Pubkey; crate::constants::MAX_TIER1_WINNERS],
    /// Entries per tier-1 shard; only the first `shard_count` slots are meaningful.
    pub shard_sizes: [u8; crate::constants::MAX_TIER1_SHARDS],
    /// `1` once shard `k`'s winners have been collected. A flag array rather than a bitmask
    /// so the struct stays align-1 (see the Pod rules above); it also removes the 8-shard
    /// ceiling a `u8` mask would have imposed.
    pub shard_done: [u8; crate::constants::MAX_TIER1_SHARDS],
    /// Number of tier-1 shards (1..=`MAX_TIER1_SHARDS`).
    pub shard_count: u8,
    /// How many slots of `winners` are filled. NOT necessarily `3 * shard_count`: a shard
    /// smaller than `SHARD_WINNERS` contributes fewer.
    pub winner_count: u8,
    /// `1` once `promote_tier1` has written the semifinal partition to `BracketState`.
    pub promoted: u8,
    /// PDA bump.
    pub bump: u8,
    /// Re-init discriminator, as little-endian `u32` bytes (a `[u8; 4]`, NOT a `u32`, so the
    /// struct stays align-1 for zero-copy). Set at `init_tier1_bracket` to the low 32 bits of
    /// the Clock slot; every tier-1 shard `RevealTop3V3Result` is stamped with it, and
    /// `collect_tier1_winners` rejects a result whose generation != this. A monotonic counter
    /// would NOT work here: `close_tier1_bracket` destroys this account and `init_tier1_bracket`
    /// (`init`, not `init_if_needed`) recreates it zeroed, resetting a counter. The Clock slot
    /// sidesteps that — the exploit needs a READY (MPC-complete) stale result, which is always
    /// many slots after the original init, so a re-init's slot is strictly greater and the
    /// stamps can never collide. (APPENDED; +4 bytes — see the size assertion below.)
    pub generation: [u8; 4],
}

/// Layout guard. bytemuck's safe `Pod` derive already rejects implicit padding, but pinning
/// the exact size catches a field being added/reordered in a way that silently changes the
/// on-chain account length (which would make every existing Tier1State undeserializable).
const _: () = assert!(
    core::mem::size_of::<Tier1State>()
        == 32
            + crate::constants::MAX_TIER1_SHARDS * 32
            + crate::constants::MAX_TIER1_WINNERS * 32
            + crate::constants::MAX_TIER1_SHARDS
            + crate::constants::MAX_TIER1_SHARDS
            + 4
            + 4, // generation: [u8; 4]
    "Tier1State size changed — check for padding or a field change"
);
const _: () = assert!(
    core::mem::align_of::<Tier1State>() == 1,
    "Tier1State must stay align-1 so no padding can appear"
);

impl Tier1State {
    /// True once every tier-1 shard's winners have been collected.
    pub fn all_shards_collected(&self) -> bool {
        self.shard_done[..self.shard_count as usize]
            .iter()
            .all(|d| *d == 1)
    }

    /// Insert `key` into `winners` keeping ascending pubkey order. Returns `false` if the
    /// array is full or the key is already present (a duplicate would corrupt the
    /// partition-by-index invariant the semifinal tier relies on).
    ///
    /// The duplicate scan is COMPLETE despite stopping early: `winners[..n]` is sorted, so
    /// once `winners[i] > key` every later element is also `> key` and cannot equal it,
    /// while every earlier element was compared directly.
    pub fn insert_winner_sorted(&mut self, key: Pubkey) -> bool {
        let n = self.winner_count as usize;
        if n >= crate::constants::MAX_TIER1_WINNERS {
            return false;
        }
        let mut pos = n;
        for i in 0..n {
            if self.winners[i] == key {
                return false;
            }
            if self.winners[i] > key {
                pos = i;
                break;
            }
        }
        // Shift right from the tail so no element is overwritten before it is copied.
        let mut i = n;
        while i > pos {
            self.winners[i] = self.winners[i - 1];
            i -= 1;
        }
        self.winners[pos] = key;
        self.winner_count += 1;
        true
    }
}

#[cfg(test)]
mod tests {
    //! Stage 5D: per-round breeding limit. These exercise the decision logic directly —
    //! the `start_breeding` body that wraps it cannot run under bankrun (its Arcium
    //! accounts don't exist) and only fully runs against a live cluster.
    use super::*;
    use crate::constants::{ENTRY_FLOWER_OFFSET, MAX_BREEDS_PER_ROUND};

    /// `migrate_entry` writes the backfilled snapshot at `8 + INIT_SPACE - 1`, i.e. it
    /// assumes `rarity_snapshot` is the LAST byte of a CompetitionEntry. Appending any field
    /// after it would silently redirect that write into the new field and leave every
    /// migrated entry ranking at rarity 0. Serialize a record with a recognisable value and
    /// prove the byte really does land last.
    #[test]
    fn rarity_snapshot_is_the_final_byte_of_an_entry() {
        let entry = CompetitionEntry {
            round: Pubkey::new_unique(),
            player: Pubkey::new_unique(),
            flower_record: Pubkey::new_unique(),
            submitted_at: 0,
            status: 0,
            bump: 0,
            encrypted_score: [0u8; crate::constants::ENTRY_SCORE_LEN],
            score_nonce: [0u8; crate::constants::ENTRY_SCORE_NONCE_LEN],
            scored: false,
            score_error_code: 0,
            score_queued: false,
            queued_at: 0,
            rarity_snapshot: 0xAB,
        };
        let mut buf = Vec::new();
        entry.serialize(&mut buf).unwrap();
        assert_eq!(
            buf.len(),
            CompetitionEntry::INIT_SPACE,
            "INIT_SPACE drifted"
        );
        assert_eq!(
            *buf.last().unwrap(),
            0xAB,
            "rarity_snapshot is no longer the last byte — migrate_entry writes the wrong one"
        );
    }

    /// The other raw offset `migrate_entry` depends on: it reads `flower_record` out of a
    /// pre-migration entry before the account can be typed. Includes the 8-byte
    /// discriminator, which the serialized struct above does not.
    #[test]
    fn entry_flower_offset_matches_the_layout() {
        let flower = Pubkey::new_unique();
        let entry = CompetitionEntry {
            round: Pubkey::new_unique(),
            player: Pubkey::new_unique(),
            flower_record: flower,
            submitted_at: 0,
            status: 0,
            bump: 0,
            encrypted_score: [0u8; crate::constants::ENTRY_SCORE_LEN],
            score_nonce: [0u8; crate::constants::ENTRY_SCORE_NONCE_LEN],
            scored: false,
            score_error_code: 0,
            score_queued: false,
            queued_at: 0,
            rarity_snapshot: 0,
        };
        let mut buf = vec![0u8; 8]; // discriminator
        entry.serialize(&mut buf).unwrap();
        assert_eq!(
            &buf[ENTRY_FLOWER_OFFSET..ENTRY_FLOWER_OFFSET + 32],
            flower.as_ref(),
            "ENTRY_FLOWER_OFFSET no longer points at flower_record"
        );
    }

    fn blank_profile() -> PlayerProfile {
        PlayerProfile {
            owner: Pubkey::default(),
            starter_claimed: false,
            total_flowers: 0,
            total_crosses: 0,
            daily_attempts: 0,
            final_submissions: 0,
            created_at: 0,
            active_experiment_count: 0,
            total_experiments: 0,
            next_flower_index: 0,
            bump: 0,
            breeds_this_round: 0,
            last_breed_round: 0,
        }
    }

    #[test]
    fn allows_exactly_the_limit_then_blocks() {
        let mut p = blank_profile();
        for i in 1..=MAX_BREEDS_PER_ROUND {
            assert!(p.register_breed_attempt(1).is_ok(), "breed {i} should pass");
            assert_eq!(p.breeds_this_round, i);
            assert_eq!(p.last_breed_round, 1);
        }
        // The (MAX+1)-th attempt in the same round is rejected and leaves the counter at MAX.
        assert!(p.register_breed_attempt(1).is_err());
        assert_eq!(p.breeds_this_round, MAX_BREEDS_PER_ROUND);
    }

    #[test]
    fn resets_when_the_round_advances() {
        let mut p = blank_profile();
        for _ in 0..MAX_BREEDS_PER_ROUND {
            p.register_breed_attempt(1).unwrap();
        }
        assert!(p.register_breed_attempt(1).is_err()); // round 1 exhausted

        // Round advances -> the lazy reset zeroes the counter and breeding resumes.
        assert!(p.register_breed_attempt(2).is_ok());
        assert_eq!(p.breeds_this_round, 1);
        assert_eq!(p.last_breed_round, 2);
    }

    // --- two-tier: sorted winner insertion (the invariant the semifinal tier depends on) ---
    fn blank_tier1() -> Tier1State {
        Tier1State {
            round: Pubkey::default(),
            shard_count: 0,
            shard_sizes: [0; crate::constants::MAX_TIER1_SHARDS],
            shard_bounds: [Pubkey::default(); crate::constants::MAX_TIER1_SHARDS],
            shard_done: [0; crate::constants::MAX_TIER1_SHARDS],
            winners: [Pubkey::default(); crate::constants::MAX_TIER1_WINNERS],
            winner_count: 0,
            promoted: 0,
            bump: 0,
            generation: [0; 4],
        }
    }
    fn pk(b: u8) -> Pubkey {
        let mut a = [0u8; 32];
        a[31] = b;
        Pubkey::new_from_array(a)
    }

    #[test]
    fn winners_stay_sorted_regardless_of_insertion_order() {
        let mut t = blank_tier1();
        for b in [7u8, 3, 9, 1, 5] {
            assert!(t.insert_winner_sorted(pk(b)));
        }
        assert_eq!(t.winner_count, 5);
        let got: Vec<u8> = (0..5).map(|i| t.winners[i].to_bytes()[31]).collect();
        assert_eq!(
            got,
            vec![1, 3, 5, 7, 9],
            "winners must be ascending by pubkey"
        );
    }

    #[test]
    fn duplicate_winner_is_refused() {
        // A duplicate would break the partition-by-index invariant the semifinals rely on.
        let mut t = blank_tier1();
        assert!(t.insert_winner_sorted(pk(4)));
        assert!(!t.insert_winner_sorted(pk(4)));
        assert_eq!(t.winner_count, 1);
    }

    #[test]
    fn winners_array_refuses_overflow_at_capacity() {
        let mut t = blank_tier1();
        for i in 0..crate::constants::MAX_TIER1_WINNERS {
            assert!(t.insert_winner_sorted(pk(i as u8)));
        }
        assert_eq!(t.winner_count as usize, crate::constants::MAX_TIER1_WINNERS);
        assert!(
            !t.insert_winner_sorted(pk(200)),
            "must refuse past capacity"
        );
    }

    #[test]
    fn all_shards_collected_tracks_the_full_shard_mask() {
        let mut t = blank_tier1();
        let n = crate::constants::MAX_TIER1_SHARDS;
        t.shard_count = n as u8;
        for k in 0..n {
            assert!(!t.all_shards_collected(), "incomplete at {k}");
            t.shard_done[k] = 1;
        }
        assert!(t.all_shards_collected());
    }

    #[test]
    fn first_breed_in_a_round_stamps_the_round_marker() {
        let mut p = blank_profile();
        assert!(p.register_breed_attempt(7).is_ok());
        assert_eq!(p.last_breed_round, 7);
        assert_eq!(p.breeds_this_round, 1);
    }

    // --- V1: hybrid collection cap boundary (proves the require! arithmetic directly, since
    //     the start_breeding body that calls check_collection_cap is unreachable under bankrun) ---
    use crate::constants::{FLOWER_COLLECTION_CAP, STARTER_COUNT};

    /// Set `total_flowers` so the profile holds exactly `hybrids` live hybrids.
    fn profile_with_hybrids(hybrids: u16) -> PlayerProfile {
        let mut p = blank_profile();
        p.total_flowers = STARTER_COUNT as u16 + hybrids;
        p
    }

    #[test]
    fn cap_allows_up_to_the_limit_then_blocks_at_the_boundary() {
        // 0 hybrids (fresh, just-claimed profile) -> allowed.
        assert!(profile_with_hybrids(0).check_collection_cap().is_ok());
        // 19 hybrids -> breeding the 20th is allowed (19 < 20).
        assert!(profile_with_hybrids(FLOWER_COLLECTION_CAP - 1)
            .check_collection_cap()
            .is_ok());
        // 20 hybrids -> breeding the 21st is blocked (20 is NOT < 20).
        assert!(profile_with_hybrids(FLOWER_COLLECTION_CAP)
            .check_collection_cap()
            .is_err());
        // Above the cap stays blocked.
        assert!(profile_with_hybrids(FLOWER_COLLECTION_CAP + 5)
            .check_collection_cap()
            .is_err());
    }

    #[test]
    fn cap_subtraction_never_underflows_below_starter_count() {
        // A profile with fewer than STARTER_COUNT flowers (shouldn't happen in practice, but
        // must not panic): saturating_sub -> 0 hybrids -> allowed.
        let mut p = blank_profile();
        p.total_flowers = 0;
        assert!(p.check_collection_cap().is_ok());
        p.total_flowers = STARTER_COUNT as u16 - 1;
        assert!(p.check_collection_cap().is_ok());
    }

    // --- Mutant target weighting: config layout + auto-restore ---------------------------

    fn blank_config() -> GameConfig {
        GameConfig {
            authority: Pubkey::new_unique(),
            paused: false,
            current_round: 0,
            starter_count: crate::constants::STARTER_COUNT,
            version: crate::constants::PROGRAM_VERSION,
            bump: 255,
            operators: [Pubkey::default(); 3],
            operator_count: 0,
            mutant_weight: crate::constants::MUTANT_WEIGHT_UNIFORM,
            restore_ts: 0,
        }
    }

    #[test]
    fn game_config_offsets_match_the_documented_layout() {
        use anchor_lang::AnchorSerialize;

        // Serialize a config whose appended fields carry sentinels, then locate them by the
        // offsets `migrate_config` writes through. This is what makes the raw byte write in
        // `migrate_config` safe: insert a field above `mutant_weight` and this fails loudly.
        let mut c = blank_config();
        c.mutant_weight = 0xAB;
        c.restore_ts = 0x0102_0304_0506_0708;

        let mut body = Vec::new();
        c.serialize(&mut body).unwrap();

        // `serialize` omits the 8-byte discriminator that Anchor prepends on-chain, so the
        // account offsets are 8 higher than the offsets into `body`.
        const DISC: usize = 8;
        assert_eq!(
            body.len() + DISC,
            8 + GameConfig::INIT_SPACE,
            "serialized GameConfig is not INIT_SPACE bytes"
        );
        assert_eq!(
            body.len() + DISC,
            158,
            "GameConfig account should be 158 bytes"
        );

        let w_off = crate::constants::GAME_CONFIG_MUTANT_WEIGHT_OFFSET;
        assert_eq!(w_off, 149, "mutant_weight offset drifted");
        assert_eq!(body[w_off - DISC], 0xAB, "mutant_weight is not at byte 149");
        assert_eq!(
            &body[w_off - DISC + 1..w_off - DISC + 9],
            &0x0102_0304_0506_0708i64.to_le_bytes(),
            "restore_ts is not at bytes 150..158"
        );

        // The pre-append layout must be untouched: 149 bytes through operator_count.
        assert_eq!(w_off, 8 + 32 + 1 + 8 + 1 + 1 + 1 + 96 + 1);
    }

    #[test]
    fn a_zero_filled_migration_still_selects_uniformly() {
        // What `migrate_config`'s `resize` alone would produce, WITHOUT its explicit 255
        // write: both appended fields zero. `restore_ts = 0` must rescue it.
        let mut c = blank_config();
        c.mutant_weight = 0;
        c.restore_ts = 0;
        assert_eq!(
            c.effective_mutant_weight(1_800_000_000),
            crate::constants::MUTANT_WEIGHT_UNIFORM,
            "a zero-filled config must behave uniformly, not exclude Mutant"
        );
    }

    #[test]
    fn the_weight_applies_only_before_restore_ts() {
        let mut c = blank_config();
        c.mutant_weight = 64;
        c.restore_ts = 1_000;

        assert_eq!(c.effective_mutant_weight(999), 64, "before restore: damped");
        assert_eq!(
            c.effective_mutant_weight(1_000),
            crate::constants::MUTANT_WEIGHT_UNIFORM,
            "at restore_ts exactly: uniform"
        );
        assert_eq!(
            c.effective_mutant_weight(1_001),
            crate::constants::MUTANT_WEIGHT_UNIFORM,
            "after restore: uniform"
        );
    }

    #[test]
    fn a_past_restore_ts_switches_the_damping_off() {
        let mut c = blank_config();
        c.mutant_weight = 0;
        c.restore_ts = -1;
        assert_eq!(
            c.effective_mutant_weight(0),
            crate::constants::MUTANT_WEIGHT_UNIFORM
        );
    }
}
