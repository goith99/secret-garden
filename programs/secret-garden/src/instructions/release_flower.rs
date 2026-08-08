use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::{CompetitionEntry, CompetitionRound, FlowerRecord, GameConfig};

/// Returns a flower that competed in a now-Finalized round to the player's collection
/// (Submitted -> Active), making it usable again: breedable, closeable, re-submittable.
///
/// `submit_entry` flips the flower to `FLOWER_STATUS_SUBMITTED` and leaves it there
/// forever; before this instruction existed, a submitted flower was permanently dead
/// weight — it could not be bred with, deleted, or entered into a later round, and it
/// still occupied a collection slot (`submit_entry` never decrements `total_flowers`).
///
/// Every check is an account constraint:
///   - `!config.paused` — a player-facing action;
///   - `round.status == ROUND_STATUS_FINALIZED` — the round must be completely done.
///     This is the gate that matters: while a round is Open/Closed its entries can still
///     be scored and revealed, and the reveal path reads the entry accounts, so pulling a
///     flower back to Active mid-round would let it be bred (mutating it) or submitted
///     elsewhere while it is still competing;
///   - the `entry` PDA (seeds bind it to `round` + `owner`) proves this player really did
///     submit to this round, and `entry.flower_record == flower` proves the flower named
///     here is the exact one that entry submitted;
///   - `entry.status == ENTRY_STATUS_SUBMITTED` makes release ONE-SHOT per entry, which is
///     what stops an old finalized entry from being replayed against a later live round;
///   - `flower.owner == owner`, `flower.status == FLOWER_STATUS_SUBMITTED`,
///     `flower.genome_status == GENOME_STATUS_ENCRYPTED` — hybrids only, mirroring
///     `close_flower`.
///
/// KNOWN LIMITATION of that last constraint: a STARTER submitted to a round is still stuck
/// Submitted forever — `release_flower` refuses it (`StarterNotDeletable`), so it stays
/// unbreedable and unsubmittable exactly as before. Unlike `close_flower`, release does not
/// touch `total_flowers`, so the accounting invariant that justifies the hybrid-only rule
/// there does not actually apply here; the restriction is carried over deliberately and can
/// be dropped later if starters should be releasable too.
///
/// ACCOUNTING: `total_flowers` is deliberately NOT touched. `submit_entry` never
/// decremented it, so the flower has occupied its collection slot continuously; the
/// `total_flowers - STARTER_COUNT == live hybrid count` invariant holds only if release
/// leaves the counter alone. (Deleting the flower afterwards via `close_flower` is what
/// decrements it, exactly once.)
#[derive(Accounts)]
pub struct ReleaseFlower<'info> {
    /// The flower's owner. Signs; pays nothing beyond the transaction fee.
    pub owner: Signer<'info>,

    /// Pause kill-switch: releasing is a player-facing action, blocked while paused.
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ SecretGardenError::GamePaused,
    )]
    pub config: Account<'info, GameConfig>,

    /// The round the flower competed in. Must be fully Finalized — see the gate note above.
    #[account(
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
        constraint = round.status == ROUND_STATUS_FINALIZED
            @ SecretGardenError::RoundNotFinalized,
    )]
    pub round: Account<'info, CompetitionRound>,

    /// The caller's entry in that round. KEPT (never closed) — it is the round's permanent
    /// record, and `round.top1/2/3` name entry pubkeys — but its `status` is flipped to
    /// `ENTRY_STATUS_RELEASED` so each entry can release its flower exactly ONCE. See
    /// `ENTRY_STATUS_RELEASED` for the replay this closes.
    #[account(
        mut,
        seeds = [ENTRY_SEED, round.key().as_ref(), owner.key().as_ref()],
        bump = entry.bump,
        constraint = entry.round == round.key() @ SecretGardenError::EntryMismatch,
        constraint = entry.flower_record == flower.key() @ SecretGardenError::EntryMismatch,
        constraint = entry.status == ENTRY_STATUS_SUBMITTED
            @ SecretGardenError::EntryAlreadyReleased,
    )]
    pub entry: Account<'info, CompetitionEntry>,

    /// The flower to release. No `seeds` needed: Anchor proves it is a program-owned
    /// `FlowerRecord`, the `owner` constraint proves it belongs to the signer, and the
    /// `entry.flower_record` constraint above pins it to this specific entry.
    #[account(
        mut,
        constraint = flower.owner == owner.key() @ SecretGardenError::FlowerNotOwned,
        constraint = flower.status == FLOWER_STATUS_SUBMITTED
            @ SecretGardenError::FlowerNotSubmitted,
        constraint = flower.genome_status == GENOME_STATUS_ENCRYPTED
            @ SecretGardenError::StarterNotDeletable,
    )]
    pub flower: Account<'info, FlowerRecord>,
}

pub(crate) fn handler(ctx: Context<ReleaseFlower>) -> Result<()> {
    ctx.accounts.flower.status = FLOWER_STATUS_ACTIVE;
    // Burn the entry's release right, so this finalized entry can never be replayed to pull
    // the same flower out of a LATER, still-live round.
    ctx.accounts.entry.status = ENTRY_STATUS_RELEASED;
    Ok(())
}
