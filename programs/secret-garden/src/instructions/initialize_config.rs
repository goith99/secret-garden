use anchor_lang::prelude::*;

use crate::constants::*;
use crate::state::GameConfig;

/// Creates the singleton `GameConfig` PDA. Callable exactly once: the `init`
/// constraint makes any second call fail because the account already exists.
#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    /// Authority that funds and administers the game config.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + GameConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, GameConfig>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(ctx: Context<InitializeConfig>) -> Result<()> {
    ctx.accounts.config.set_inner(GameConfig {
        authority: ctx.accounts.authority.key(),
        paused: false,
        current_round: 0,
        starter_count: STARTER_COUNT,
        version: PROGRAM_VERSION,
        bump: ctx.bumps.config,
        operators: [Pubkey::default(); 3],
        operator_count: 0,
        // Uniform target selection, with the auto-restore already in the past. A fresh config
        // therefore behaves exactly as it did before the weighting existed, twice over — the
        // weight says "no reduction" AND the restore gate has already fired. Damping is only
        // ever switched on deliberately, via `set_mutant_weight`.
        mutant_weight: MUTANT_WEIGHT_UNIFORM,
        restore_ts: 0,
        // Unset sentinel — every fee path refuses to run until `set_sgd_mint` pins it.
        sgd_mint: Pubkey::default(),
        // No handover in flight at genesis.
        pending_authority: Pubkey::default(),
    });
    Ok(())
}
