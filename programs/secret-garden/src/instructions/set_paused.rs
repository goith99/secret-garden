use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::GameConfig;

/// Authority-only kill-switch toggle. `GameConfig::paused` has existed since Stage 1 but
/// shipped with no instruction to set it (Stage 1 could only seed it via test scaffolding);
/// Stage 5A adds the real instruction. When `paused == true`, player-facing instructions
/// reject with `GamePaused`; permissionless recovery instructions remain callable.
#[derive(Accounts)]
pub struct SetPaused<'info> {
    /// Must equal `config.authority`.
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ SecretGardenError::NotAuthority,
    )]
    pub config: Account<'info, GameConfig>,
}

pub(crate) fn handler(ctx: Context<SetPaused>, new_value: bool) -> Result<()> {
    ctx.accounts.config.paused = new_value;
    Ok(())
}
