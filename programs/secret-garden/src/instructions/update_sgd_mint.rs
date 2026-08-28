use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, TokenAccount};

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::{CompetitionRound, GameConfig};

/// Re-points `GameConfig.sgd_mint` at a different mint. Authority-only.
///
/// SEPARATE FROM `set_sgd_mint`, WHICH STAYS ONE-TIME. That instruction's job is the initial
/// pin, and its refusal to run twice is a real safety property: it means a compromised
/// authority cannot silently redirect a live pot mid-round. Relaxing it would have thrown that
/// away to serve a migration. This is the migration, with the guards the initial pin does not
/// need.
///
/// WHY A MINT CHANGE IS DANGEROUS. Three separate paths pin themselves to `config.sgd_mint`:
/// `submit_entry` (the fee), `distribute_pot` (the payout) and `close_pot_vault` (the rent).
/// A round's pot vault is an associated token account of THE MINT THAT WAS CONFIGURED WHEN
/// `open_round` RAN. Move the mint under a live round and every one of those constraints stops
/// matching that vault: the round cannot be entered, its pot cannot be paid out, and its rent
/// cannot be reclaimed. The tokens are not lost in the sense of being burned — they sit in an
/// account nothing is authorised to touch, which is worse, because it looks recoverable.
///
/// So this refuses unless BOTH hold:
///   1. the current round is FINALIZED — no round is mid-flight;
///   2. that round's pot vault, under the OUTGOING mint, is EMPTY — whatever was collected has
///      already been distributed (or none ever was).
///
/// Together those mean nothing denominated in the outgoing mint is still owed by the program.
/// Older rounds' vaults are not checked here and cannot be: there is no bounded way to
/// enumerate them on chain. Settle any outstanding pot with `distribute_pot` BEFORE calling
/// this — after it, that pot is unreachable.
#[derive(Accounts)]
pub struct UpdateSgdMint<'info> {
    /// Must equal `config.authority`.
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ SecretGardenError::NotAuthority,
    )]
    pub config: Account<'info, GameConfig>,

    /// The round at `config.current_round`. Seed-checked, so the caller cannot present some
    /// other (already finalized) round to satisfy the status gate below.
    #[account(
        seeds = [ROUND_SEED, config.current_round.to_le_bytes().as_ref()],
        bump = round.bump,
    )]
    pub round: Account<'info, CompetitionRound>,

    /// That round's pot vault under the OUTGOING mint. Its owner is checked in the handler
    /// against the round-derived pot authority, so an unrelated empty token account cannot be
    /// substituted to pass the drained check.
    #[account(constraint = old_pot_vault.mint == config.sgd_mint @ SecretGardenError::WrongSgdMint)]
    pub old_pot_vault: Account<'info, TokenAccount>,

    /// The incoming mint. Typed so an unparseable account cannot be pinned.
    pub new_sgd_mint: Account<'info, Mint>,
}

pub(crate) fn handler(ctx: Context<UpdateSgdMint>) -> Result<()> {
    require!(
        ctx.accounts.round.status == ROUND_STATUS_FINALIZED,
        SecretGardenError::RoundNotFinalized
    );

    // The vault must be THIS round's, not any empty account that happens to hold the old mint.
    let (expected_authority, _) = Pubkey::find_program_address(
        &[POT_SEED, ctx.accounts.round.round_id.to_le_bytes().as_ref()],
        ctx.program_id,
    );
    require_keys_eq!(
        ctx.accounts.old_pot_vault.owner,
        expected_authority,
        SecretGardenError::WrongSgdMint
    );
    require!(
        ctx.accounts.old_pot_vault.amount == 0,
        SecretGardenError::PotNotDrained
    );

    // A no-op re-pin is a caller mistake worth naming rather than silently accepting.
    require_keys_neq!(
        ctx.accounts.new_sgd_mint.key(),
        ctx.accounts.config.sgd_mint,
        SecretGardenError::SgdMintAlreadySet
    );

    ctx.accounts.config.sgd_mint = ctx.accounts.new_sgd_mint.key();
    Ok(())
}
