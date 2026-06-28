use anchor_lang::prelude::*;

use crate::constants::{
    ENCRYPTED_GENOME_LEN, ENCRYPTION_METADATA_LEN, ENTRY_SCORE_LEN, ENTRY_SCORE_NONCE_LEN,
    GENOME_COMMITMENT_LEN,
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
    /// Submission deadline: `start_time + ROUND_DURATION_SECONDS`.
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

#[cfg(test)]
mod tests {
    //! Stage 5D: per-round breeding limit. These exercise the decision logic directly —
    //! the `start_breeding` body that wraps it cannot run under bankrun (its Arcium
    //! accounts don't exist) and only fully runs against a live cluster.
    use super::*;
    use crate::constants::MAX_BREEDS_PER_ROUND;

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

    #[test]
    fn first_breed_in_a_round_stamps_the_round_marker() {
        let mut p = blank_profile();
        assert!(p.register_breed_attempt(7).is_ok());
        assert_eq!(p.last_breed_round, 7);
        assert_eq!(p.breeds_this_round, 1);
    }
}
