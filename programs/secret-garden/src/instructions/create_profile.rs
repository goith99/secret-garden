use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::{GameConfig, PlayerProfile};

/// Creates the caller's `PlayerProfile` PDA. Callable once per wallet: the `init`
/// constraint makes a second call fail because the account already exists.
#[derive(Accounts)]
pub struct CreateProfile<'info> {
    /// Wallet that owns (and funds) the new profile.
    #[account(mut)]
    pub owner: Signer<'info>,

    /// Game config, read to enforce the pause kill-switch.
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ SecretGardenError::GamePaused,
    )]
    pub config: Account<'info, GameConfig>,

    #[account(
        init,
        payer = owner,
        space = 8 + PlayerProfile::INIT_SPACE,
        seeds = [PROFILE_SEED, owner.key().as_ref()],
        bump,
    )]
    pub profile: Account<'info, PlayerProfile>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(ctx: Context<CreateProfile>) -> Result<()> {
    ctx.accounts.profile.set_inner(PlayerProfile {
        owner: ctx.accounts.owner.key(),
        starter_claimed: false,
        total_flowers: 0,
        total_crosses: 0,
        daily_attempts: 0,
        final_submissions: 0,
        created_at: Clock::get()?.unix_timestamp,
        // Stage 3A: no breeding experiments at profile creation.
        active_experiment_count: 0,
        total_experiments: 0,
        // Stage 3B: starters will occupy indices 0..=5 (set in claim_starters).
        next_flower_index: 0,
        bump: ctx.bumps.profile,
        // Stage 5D: no breeds yet; the counter resets lazily on the first breed anyway.
        breeds_this_round: 0,
        last_breed_round: 0,
    });
    Ok(())
}
