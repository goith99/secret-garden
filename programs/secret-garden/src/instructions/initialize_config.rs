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
    });
    Ok(())
}
