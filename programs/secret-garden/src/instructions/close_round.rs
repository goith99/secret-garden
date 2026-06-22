use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::CompetitionRound;

/// Closes an Open round. Only the operator that opened it may close it. There is
/// intentionally no time check — the operator may close early or after the deadline.
#[derive(Accounts)]
pub struct CloseRound<'info> {
    /// Operator that opened the round.
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
        has_one = authority @ SecretGardenError::NotAuthority,
    )]
    pub round: Account<'info, CompetitionRound>,
}

pub(crate) fn handler(ctx: Context<CloseRound>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(
        round.status == ROUND_STATUS_OPEN,
        SecretGardenError::RoundNotOpen
    );
    round.status = ROUND_STATUS_CLOSED;
    Ok(())
}
