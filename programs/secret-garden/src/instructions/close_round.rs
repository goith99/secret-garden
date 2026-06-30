use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::{is_operator_or_authority, CompetitionRound, GameConfig};

/// Closes an Open round. Callable by the authority or any registered operator. The
/// authority may close at any time (manual override); an operator may only close once the
/// round has been open at least `MIN_OPERATOR_CLOSE_DELAY_SECONDS`.
#[derive(Accounts)]
pub struct CloseRound<'info> {
    /// Authority or operator. (Field kept named `authority` so existing clients/IDL keys
    /// are unchanged; the actual authorization is the runtime operator-or-authority check.)
    pub authority: Signer<'info>,

    /// Game config, read to authorize the signer (authority or operator). No pause gate:
    /// closing a round is winding down in-flight game state, which must work while paused.
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

pub(crate) fn handler(ctx: Context<CloseRound>) -> Result<()> {
    let signer = ctx.accounts.authority.key();
    require!(
        is_operator_or_authority(&ctx.accounts.config, &signer),
        SecretGardenError::NotAuthority
    );

    let round = &mut ctx.accounts.round;
    require!(
        round.status == ROUND_STATUS_OPEN,
        SecretGardenError::RoundNotOpen
    );

    // Operators (non-authority signers) may only close after the minimum open window; the
    // authority can close at any time as a manual override.
    if signer != ctx.accounts.config.authority {
        let now = Clock::get()?.unix_timestamp;
        require!(
            now - round.start_time >= MIN_OPERATOR_CLOSE_DELAY_SECONDS,
            SecretGardenError::RoundTooRecentToClose
        );
    }

    round.status = ROUND_STATUS_CLOSED;
    Ok(())
}
