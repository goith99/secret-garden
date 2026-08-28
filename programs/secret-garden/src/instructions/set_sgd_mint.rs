use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::GameConfig;

/// Pins the $SGD mint this deployment charges entry fees in and pays pots from.
///
/// ONE-TIME and authority-only. Once set it can never be re-pointed, which is the whole
/// security value: every fee and payout path validates against `config.sgd_mint`, so if this
/// were mutable a compromised authority could aim a live pot at a mint it controls and drain
/// it through a fake "winner". Immutability turns that from a key-compromise problem into a
/// non-problem.
#[derive(Accounts)]
pub struct SetSgdMint<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// No pause gate: this is administration, which must work while paused (same rule as
    /// operator management and the migrations).
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ SecretGardenError::NotAuthority,
    )]
    pub config: Account<'info, GameConfig>,

    /// Typed as `Mint` so a non-mint account cannot be pinned by mistake — an unparseable
    /// mint here would brick every `submit_entry` until a redeploy, and there is no way back
    /// because the setter is one-time.
    pub sgd_mint: Account<'info, Mint>,
}

pub(crate) fn handler(ctx: Context<SetSgdMint>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.config.sgd_mint,
        Pubkey::default(),
        SecretGardenError::SgdMintAlreadySet
    );
    ctx.accounts.config.sgd_mint = ctx.accounts.sgd_mint.key();
    Ok(())
}
