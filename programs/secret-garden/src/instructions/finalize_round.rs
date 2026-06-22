use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::CompetitionRound;

/// Finalizes a Closed round. Only the operator that opened it may finalize it. Stage 2
/// does no scoring here — that (Top 3, etc.) is Stage 4.
#[derive(Accounts)]
pub struct FinalizeRound<'info> {
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

pub(crate) fn handler(ctx: Context<FinalizeRound>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(
        round.status == ROUND_STATUS_CLOSED,
        SecretGardenError::RoundNotClosed
    );
    round.status = ROUND_STATUS_FINALIZED;
    Ok(())
}
