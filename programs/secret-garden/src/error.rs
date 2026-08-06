use anchor_lang::prelude::*;

#[error_code]
pub enum SecretGardenError {
    /// The `GameConfig` singleton has already been created. (Surfaced explicitly for
    /// API completeness; the `init` constraint also blocks a second initialization.)
    #[msg("Game config has already been initialized")]
    AlreadyInitialized,
    /// Signer does not match `GameConfig::authority`. Reserved for admin instructions
    /// introduced in later stages.
    #[msg("Signer is not the configured authority")]
    NotAuthority,
    /// The game is paused; player-facing instructions are rejected.
    #[msg("The game is currently paused")]
    GamePaused,
    /// A `PlayerProfile` already exists for this wallet. (The `init` constraint also
    /// blocks a second profile for the same owner.)
    #[msg("A profile already exists for this wallet")]
    ProfileAlreadyExists,
    /// Starter flowers have already been claimed by this profile.
    #[msg("Starter flowers have already been claimed")]
    StartersAlreadyClaimed,
    /// A flower index has no corresponding entry in the `SPECIES` table.
    #[msg("Species index is out of range")]
    InvalidSpecies,

    // --- Stage 2: competition rounds ---
    /// A new round cannot open until the previous round is Finalized.
    #[msg("The previous round has not been finalized")]
    PreviousRoundNotFinalized,
    /// The round is not Open (entries can only be submitted to an Open round).
    #[msg("The round is not open")]
    RoundNotOpen,
    /// The round's submission deadline (`end_time`) has passed.
    #[msg("The round deadline has passed")]
    RoundDeadlinePassed,
    /// The round has already reached `max_participants`.
    #[msg("The round is full")]
    RoundFull,
    /// The referenced flower is not owned by the signer.
    #[msg("The flower is not owned by the signer")]
    FlowerNotOwned,
    /// The referenced flower is not Active (already Submitted, or otherwise unusable).
    #[msg("The flower is not active")]
    FlowerNotActive,
    /// The round is not Closed (it must be Closed before it can be Finalized).
    #[msg("The round is not closed")]
    RoundNotClosed,

    // --- Stage 3A: encrypted breeding ---
    /// Both breeding parents resolve to the same flower account.
    #[msg("The two parents must be distinct flowers")]
    ParentsMustBeDistinct,
    /// The Arcium computation failed / was aborted (returned by the breed callback).
    #[msg("The computation was aborted")]
    AbortedComputation,

    // --- Stage 3B: breeding resolution ---
    /// `cancel_expired_experiment` called before `EXPERIMENT_TIMEOUT_SECONDS` elapsed.
    #[msg("The experiment has not yet expired")]
    ExperimentNotYetExpired,
    /// The experiment is already Completed/Failed/Expired (cannot be resolved again).
    #[msg("The experiment has already been resolved")]
    ExperimentAlreadyResolved,

    // --- Stage 4A: scoring ---
    /// `queue_reveal_top3` called before every entry in the round was scored.
    #[msg("Not all entries have been scored yet")]
    ScoringIncomplete,
    /// The round's scoring has already been revealed/finalized.
    #[msg("Scoring has already been revealed")]
    ScoringAlreadyRevealed,

    // --- Stage 4B ---
    /// `queue_score_entry` called for an entry that has already been scored.
    #[msg("This entry has already been scored")]
    EntryAlreadyScored,
    /// `queue_reveal_top3` received the wrong number of entry accounts (must equal the
    /// round's participant_count).
    #[msg("Wrong number of entry accounts for the round")]
    WrongEntryCount,

    // --- Stage 5A: hardening (recovery + pause toggle) ---
    /// `queue_score_entry` called for an entry that already has a scoring computation in
    /// flight (`score_queued == true`). Prevents duplicate concurrent queues; clears only
    /// via the callback or `cancel_stuck_score`.
    #[msg("A scoring computation is already in flight for this entry")]
    ScoreAlreadyQueued,
    /// `cancel_stuck_score` called on an entry that is not currently queued for scoring
    /// (nothing to reset — it was never queued, already scored, or already reset).
    #[msg("The entry is not currently queued for scoring")]
    ScoreNotQueued,
    /// `cancel_stuck_score` called before `SCORE_TIMEOUT_SECONDS` elapsed since queuing.
    #[msg("The scoring computation has not yet timed out")]
    ScoreNotYetTimedOut,
    /// `reclaim_dead_offspring` called on an experiment whose status is not Failed/Expired
    /// (only a dead experiment's pre-created offspring may be reclaimed).
    #[msg("The experiment is not in a failed or expired state")]
    ExperimentNotDead,
    /// `reclaim_dead_offspring`: the offspring is not the Locked dead flower bound to this
    /// experiment (wrong flower, or it became Active from a successful breeding).
    #[msg("The offspring is not a reclaimable dead flower for this experiment")]
    OffspringNotReclaimable,
    /// `reclaim_dead_offspring`: the rent destination does not match the flower's recorded
    /// owner (rent must return to the player who paid it).
    #[msg("The rent destination must be the flower owner")]
    InvalidRentDestination,

    // --- Stage 5D: per-round breeding limit ---
    /// `start_breeding` called after the wallet already used all `MAX_BREEDS_PER_ROUND`
    /// attempts in the current round. Resets automatically when a new round opens.
    #[msg("You have used all 5 breeding attempts for this round")]
    BreedingLimitReached,

    // --- Multi-operator support ---
    /// `add_operator` called when all three operator slots are already filled.
    #[msg("All operator slots are full (max 3)")]
    OperatorSlotsFull,
    /// `add_operator` called with a pubkey that is already an operator.
    #[msg("That operator is already registered")]
    OperatorAlreadyExists,
    /// `remove_operator` called with a pubkey that is not currently an operator.
    #[msg("That operator was not found")]
    OperatorNotFound,
    /// `add_operator` called with `Pubkey::default()` or the authority itself.
    #[msg("Invalid operator pubkey")]
    InvalidOperator,
    /// An operator (non-authority) tried to close a round that has been open for less than
    /// the minimum delay. The authority may close at any time.
    #[msg("The round has been open too briefly for an operator to close it")]
    RoundTooRecentToClose,

    // --- Private Hint ---
    /// `queue_private_hint` requires the CURRENT round to be Open — no Open round means
    /// there are no target traits to check a flower against yet.
    #[msg("There is no active (open) round to request a hint for")]
    NoActiveRound,

    // --- V1: hybrid collection cap + delete ---
    /// `start_breeding` refused because the player already holds `FLOWER_COLLECTION_CAP`
    /// live hybrids; they must `close_flower` some first.
    #[msg("Your hybrid collection is full; delete some flowers to breed more")]
    CollectionFull,
    /// `close_flower` called on a starter flower — starters are permanent and never
    /// deletable (this preserves the `total_flowers - STARTER_COUNT` accounting invariant).
    #[msg("Starter flowers cannot be deleted")]
    StarterNotDeletable,

    // --- Bracket reveal (ADDITIVE) ---
    /// `init_bracket`: the declared shard sizes do not sum to `participant_count`, or a
    /// shard is outside `MIN_SHARD_SIZE..=MAX_SHARD_SIZE`, or `shard_count` is out of range.
    #[msg("The declared shard layout is invalid for this round")]
    InvalidShardLayout,
    /// The supplied entry accounts are not in strictly ascending pubkey order, or do not
    /// start at this shard's recorded boundary, or cross into the next shard's range.
    #[msg("Shard entries must be strictly ascending and within this shard's bounds")]
    ShardEntriesOutOfRange,
    /// `queue_shard_reveal`/`collect_shard_winners` given a `shard_index >= shard_count`.
    #[msg("That shard index does not exist in this bracket")]
    InvalidShardIndex,
    /// `collect_shard_winners` before the shard's reveal callback has landed.
    #[msg("That shard's reveal has not produced a result yet")]
    ShardResultNotReady,
    /// `collect_shard_winners` called twice for the same shard.
    #[msg("That shard's winners were already collected")]
    ShardAlreadyCollected,
    /// `queue_final_reveal` before every shard has been collected.
    #[msg("Every shard must be revealed and collected before the final reveal")]
    BracketNotReady,
    /// `queue_final_reveal` called while a final reveal is already in flight, or
    /// `apply_bracket_result` called twice.
    #[msg("The final reveal has already been queued or applied")]
    BracketAlreadyFinal,
    /// The finalist accounts supplied do not match the ones recorded in `BracketState`.
    #[msg("The supplied finalists do not match the recorded shard winners")]
    FinalistMismatch,
    /// A bracket instruction was pointed at a round whose `BracketState` belongs elsewhere.
    #[msg("This bracket does not belong to that round")]
    BracketRoundMismatch,

    // --- two-tier bracket (ADDITIVE) ---
    /// `init_tier1_bracket` on a round small enough for the single-tier path, or
    /// a single-tier instruction used on a round that needs two tiers.
    #[msg("This round's size does not match the bracket tier being used")]
    WrongBracketTier,
    /// `promote_tier1` before every tier-1 shard has been collected.
    #[msg("Every tier-1 shard must be collected before promotion")]
    Tier1NotReady,
    /// `promote_tier1` called twice, or a tier-1 instruction after promotion.
    #[msg("Tier 1 has already been promoted to the semifinal tier")]
    Tier1AlreadyPromoted,
    /// A semifinal instruction used before `promote_tier1` wrote the semifinal partition.
    #[msg("The semifinal tier is not ready — promote tier 1 first")]
    SemifinalNotReady,
    /// The supplied accounts are not exactly this semifinal's slice of the sorted tier-1
    /// winners, by index.
    #[msg("The supplied accounts are not this semifinal's slice of the tier-1 winners")]
    SemifinalSliceMismatch,
    /// `collect_shard_winners` produced a duplicate or overflowed the tier-1 winner array.
    #[msg("Could not record that tier-1 winner (duplicate or capacity reached)")]
    Tier1WinnerRejected,
}
