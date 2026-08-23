use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::GameConfig;

/// Authority-only override for the temporary Mutant target-weighting (see
/// `GameConfig::mutant_weight`). Mirrors `set_paused`: same `has_one` authority gate, same
/// single-account shape, no side effects beyond the two fields it writes.
///
/// AUTHORITY, NOT OPERATOR — deliberately. Operators run rounds; this changes the RULES a
/// round is generated under, which sits with `set_paused` and the operator-administration
/// instructions rather than with `open_round`. `is_operator_or_authority` is not used here.
///
/// Both fields are written together on purpose. A weight with a stale `restore_ts` in the
/// past is inert (`effective_mutant_weight` short-circuits to uniform), which would look like
/// the instruction silently did nothing — so the caller always states both the strength and
/// the expiry of the damping in one transaction.
///
/// No new error variant: the only failure mode is a non-authority signer, which `has_one`
/// already reports as `NotAuthority`. Every `new_weight` in 0..=255 and every `new_restore_ts`
/// is meaningful — 255 or a past timestamp are the two equivalent ways to switch it off — so
/// there is nothing left to validate.
#[derive(Accounts)]
pub struct SetMutantWeight<'info> {
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

pub(crate) fn handler(
    ctx: Context<SetMutantWeight>,
    new_weight: u8,
    new_restore_ts: i64,
) -> Result<()> {
    ctx.accounts.config.mutant_weight = new_weight;
    ctx.accounts.config.restore_ts = new_restore_ts;
    Ok(())
}
