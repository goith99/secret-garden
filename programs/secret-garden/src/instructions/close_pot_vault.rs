use anchor_lang::prelude::*;
use anchor_spl::token::{
    close_account, transfer_checked, CloseAccount, Mint, Token, TokenAccount, TransferChecked,
};

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::{is_operator_or_authority, CompetitionRound, GameConfig, RoundSettlement};

/// Reclaims the rent under a settled round's pot vault, sweeping any unclaimed surplus first.
///
/// SETTLED means one thing now: `RoundSettlement::is_terminal()`. There used to be two raw
/// account probes here — one for a distribution marker, one for a refund marker, each
/// deserialized by hand and each with its own round-id check — to answer a question that is now
/// a single field read. Which of the two ways a pot ended no longer matters to this
/// instruction, and it no longer has to know.
///
/// # The surplus sweep
///
/// A refunded round deliberately leaves money behind. Entrants are paid a flat
/// `ENTRY_FEE_SGD` each, so donations into the vault — and the truncation remainder in the
/// shortfall case — belong to nobody and stay put. SPL's `close_account` refuses a non-empty
/// account, so without a sweep every refunded round's rent would be stuck behind its own
/// leftovers.
///
/// Sweeping here rather than in the refund also closes a griefing vector that predates all of
/// this: a single base unit donated into ANY finished round's vault used to make it permanently
/// un-closeable, because nothing could empty it again. Now the close drains whatever is present
/// at the moment it runs, whenever the donation arrived and whichever path settled the round.
///
/// The destination is `config.authority`'s token account — not the caller's. The caller may be
/// any operator, and letting whoever happens to run the close pocket the donations would make
/// the destination a function of transaction timing. The rent still goes to the caller, which
/// is unchanged and correct: the caller is paying for the transaction.
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

    /// The single settlement state. Typed, so a wrong or absent account fails on the
    /// discriminator rather than on a hand-rolled emptiness probe.
    #[account(
        seeds = [ROUND_SETTLEMENT_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = settlement.bump,
    )]
    pub settlement: Account<'info, RoundSettlement>,

    /// CHECK: PDA authority for the vault; derived, never a keypair.
    #[account(seeds = [POT_SEED, round.round_id.to_le_bytes().as_ref()], bump)]
    pub pot_authority: UncheckedAccount<'info>,

    /// The round's pot, PINNED TO THE ASSOCIATED TOKEN ACCOUNT rather than merely checked for
    /// owner and mint. A non-ATA lookalike owned by the same PDA satisfies owner-and-mint but
    /// is not this round's vault; closing one would reclaim the wrong account's rent and leave
    /// the real vault open. See `distribute_pot` for the full shape of the substitution.
    #[account(
        mut,
        associated_token::mint = sgd_mint,
        associated_token::authority = pot_authority,
    )]
    pub pot_vault: Account<'info, TokenAccount>,

    #[account(constraint = sgd_mint.key() == config.sgd_mint @ SecretGardenError::WrongSgdMint)]
    pub sgd_mint: Account<'info, Mint>,

    /// Where unclaimed surplus goes. Pinned to `config.authority`'s $SGD account, so neither
    /// the caller nor the ordering of anything can redirect it.
    #[account(
        mut,
        constraint = surplus_destination.owner == config.authority @ SecretGardenError::WrongWinnerAccount,
        constraint = surplus_destination.mint == config.sgd_mint @ SecretGardenError::WrongSgdMint,
    )]
    pub surplus_destination: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub(crate) fn handler(ctx: Context<ClosePotVault>) -> Result<()> {
    require!(
        is_operator_or_authority(&ctx.accounts.config, &ctx.accounts.authority.key()),
        SecretGardenError::NotAuthority
    );

    // The whole settlement question, in one line.
    require_eq!(
        ctx.accounts.settlement.round_id,
        ctx.accounts.round.round_id,
        SecretGardenError::PotNotSettled
    );
    require!(
        ctx.accounts.settlement.is_terminal(),
        if ctx.accounts.settlement.state == SETTLEMENT_POT_REFUND_PENDING {
            SecretGardenError::RefundIncomplete
        } else {
            SecretGardenError::PotNotSettled
        }
    );

    let round_id_le = ctx.accounts.round.round_id.to_le_bytes();
    let seeds: &[&[u8]] = &[POT_SEED, round_id_le.as_ref(), &[ctx.bumps.pot_authority]];

    // Sweep before closing. Reads the live balance rather than the recorded surplus, so a
    // donation that landed after settlement is swept too and cannot wedge the close.
    let leftover = ctx.accounts.pot_vault.amount;
    if leftover > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.pot_vault.to_account_info(),
                    mint: ctx.accounts.sgd_mint.to_account_info(),
                    to: ctx.accounts.surplus_destination.to_account_info(),
                    authority: ctx.accounts.pot_authority.to_account_info(),
                },
                &[seeds],
            ),
            leftover,
            ctx.accounts.sgd_mint.decimals,
        )?;
        msg!("swept {} unclaimed base units to the authority", leftover);
    }

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
