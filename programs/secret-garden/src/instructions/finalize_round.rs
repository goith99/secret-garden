use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::{is_operator_or_authority, CompetitionRound, GameConfig};

/// Finalizes a Closed round. Callable by the authority or any registered operator. No
/// scoring happens here — that (Top 3, etc.) is Stage 4.
#[derive(Accounts)]
pub struct FinalizeRound<'info> {
    /// Authority or operator. (Field kept named `authority` for client/IDL stability; the
    /// authorization is the runtime operator-or-authority check.)
    pub authority: Signer<'info>,

    /// Game config, read to authorize the signer (authority or operator). No pause gate:
    /// finalizing winds down in-flight game state, which must work while paused.
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, GameConfig>,

    #[account(
        mut,
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
    )]
    pub round: Account<'info, CompetitionRound>,
}

pub(crate) fn handler(ctx: Context<FinalizeRound>) -> Result<()> {
    require!(
        is_operator_or_authority(&ctx.accounts.config, &ctx.accounts.authority.key()),
        SecretGardenError::NotAuthority
    );

    let round = &mut ctx.accounts.round;
    require!(
        round.status == ROUND_STATUS_CLOSED,
        SecretGardenError::RoundNotClosed
    );
    round.status = ROUND_STATUS_FINALIZED;
    Ok(())
}
