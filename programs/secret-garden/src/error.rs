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
}
