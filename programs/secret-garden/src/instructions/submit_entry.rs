use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::{CompetitionEntry, CompetitionRound, FlowerRecord, GameConfig, PlayerProfile};

/// Submits one of the player's Active flowers as an entry into an Open round.
///
/// The `entry` PDA is unique per (round, player); a second submission by the same
/// wallet collides on `init` and is rejected structurally — there is no separate
/// duplicate check.
#[derive(Accounts)]
pub struct SubmitEntry<'info> {
    /// The player submitting the entry; funds the entry account.
    #[account(mut)]
    pub player: Signer<'info>,

    /// Game config, read to enforce the pause kill-switch (Stage 5A: this player-facing
    /// instruction previously had no pause gate — added here, logic otherwise unchanged).
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ SecretGardenError::GamePaused,
    )]
    pub config: Account<'info, GameConfig>,

    #[account(
        mut,
        seeds = [PROFILE_SEED, player.key().as_ref()],
        bump = profile.bump,
    )]
    pub profile: Account<'info, PlayerProfile>,

    /// Target round. The seed check ties the passed account to its stored `round_id`.
    #[account(
        mut,
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
    )]
    pub round: Account<'info, CompetitionRound>,

    /// Flower being submitted. Ownership and status are validated in the handler.
    #[account(mut)]
    pub flower_record: Account<'info, FlowerRecord>,

    #[account(
        init,
        payer = player,
        space = 8 + CompetitionEntry::INIT_SPACE,
        seeds = [ENTRY_SEED, round.key().as_ref(), player.key().as_ref()],
        bump,
    )]
    pub entry: Account<'info, CompetitionEntry>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(ctx: Context<SubmitEntry>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let player = ctx.accounts.player.key();
    let entry_bump = ctx.bumps.entry;

    {
        let flower = &ctx.accounts.flower_record;
        require!(flower.owner == player, SecretGardenError::FlowerNotOwned);
        require!(
            flower.status == FLOWER_STATUS_ACTIVE,
            SecretGardenError::FlowerNotActive
        );
    }
    {
        let round = &ctx.accounts.round;
        require!(
            round.status == ROUND_STATUS_OPEN,
            SecretGardenError::RoundNotOpen
        );
        require!(now < round.end_time, SecretGardenError::RoundDeadlinePassed);
        require!(
            round.participant_count < round.max_participants,
            SecretGardenError::RoundFull
        );
    }

    let round_key = ctx.accounts.round.key();
    let flower_key = ctx.accounts.flower_record.key();

    ctx.accounts.entry.set_inner(CompetitionEntry {
        round: round_key,
        player,
        flower_record: flower_key,
        submitted_at: now,
        status: ENTRY_STATUS_SUBMITTED,
        bump: entry_bump,
        // Stage 4B: scoring fields start empty (filled by score_entry_callback).
        encrypted_score: [0u8; ENTRY_SCORE_LEN],
        score_nonce: [0u8; ENTRY_SCORE_NONCE_LEN],
        scored: false,
        score_error_code: 0,
        // Stage 5A: no scoring computation queued at submission time.
        score_queued: false,
        queued_at: 0,
    });

    // Mark the flower used and bump the counters. `participant_count` is guarded above
    // so the increment cannot overflow; `final_submissions` is saturated as a u8 cap.
    ctx.accounts.flower_record.status = FLOWER_STATUS_SUBMITTED;
    ctx.accounts.round.participant_count += 1;
    ctx.accounts.profile.final_submissions =
        ctx.accounts.profile.final_submissions.saturating_add(1);
    Ok(())
}
