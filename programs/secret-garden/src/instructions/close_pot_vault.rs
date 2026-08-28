use anchor_lang::prelude::*;
use anchor_spl::token::{close_account, CloseAccount, Token, TokenAccount};

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::{is_operator_or_authority, CompetitionRound, GameConfig, PotDistribution};

/// Reclaims the rent sitting under a round's pot vault once the pot has been paid out.
///
/// Requires the `PotDistribution` marker to exist, so a vault can only be closed after its
/// round was actually distributed — never before, which would strand players' fees. SPL's
/// `close_account` itself refuses to close a non-empty account, so this cannot destroy tokens
/// even if the marker check were somehow satisfied early.
#[derive(Accounts)]
pub struct ClosePotVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GameConfig>,

    #[account(
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
    )]
    pub round: Account<'info, CompetitionRound>,

    /// Proof the pot was distributed. Not `mut` and not closed — it must outlive the vault,
    /// because it is the replay guard: deleting it would let `distribute_pot` run again on a
    /// refilled vault.
    #[account(
        seeds = [POT_DIST_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = pot_distribution.bump,
    )]
    pub pot_distribution: Account<'info, PotDistribution>,

    /// CHECK: PDA authority for the vault; derived, never a keypair.
    #[account(seeds = [POT_SEED, round.round_id.to_le_bytes().as_ref()], bump)]
    pub pot_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = pot_vault.owner == pot_authority.key() @ SecretGardenError::WrongSgdMint,
        constraint = pot_vault.mint == config.sgd_mint @ SecretGardenError::WrongSgdMint,
    )]
    pub pot_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub(crate) fn handler(ctx: Context<ClosePotVault>) -> Result<()> {
    require!(
        is_operator_or_authority(&ctx.accounts.config, &ctx.accounts.authority.key()),
        SecretGardenError::NotAuthority
    );

    let round_id_le = ctx.accounts.round.round_id.to_le_bytes();
    let seeds: &[&[u8]] = &[POT_SEED, round_id_le.as_ref(), &[ctx.bumps.pot_authority]];

    close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        CloseAccount {
            account: ctx.accounts.pot_vault.to_account_info(),
            destination: ctx.accounts.authority.to_account_info(),
            authority: ctx.accounts.pot_authority.to_account_info(),
        },
        &[seeds],
    ))?;
    Ok(())
}
