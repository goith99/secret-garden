use anchor_lang::prelude::*;
use anchor_spl::token::{
    close_account, transfer_checked, CloseAccount, Mint, Token, TokenAccount, TransferChecked,
};

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::{is_operator_or_authority, CompetitionRound, GameConfig, RoundSettlement};

/// Reclaims the rent under a settled round's pot vault, sweeping any unclaimed surplus first.
///
/// SETTLED means `RoundSettlement::is_terminal()`. There used to be two raw account probes here
/// — one for a distribution marker, one for a refund marker, each deserialized by hand and each
/// with its own round-id check — to answer a question that is now a single field read. Which of
/// the two ways a pot ended no longer matters to this instruction, and it no longer has to know.
///
/// # The round that can never settle
///
/// One shape of round has no terminal settlement and never will: one that FINALIZED with
/// `participant_count == 0`. `open_round` creates a vault for every round, funded by the
/// operator, before anyone has entered — so an empty round still gets one. With no entries
/// there is nothing to score, `scoring_revealed` never becomes true, and `distribute_pot`
/// refuses it forever. Its rent used to be stranded permanently, one vault per empty round,
/// accumulating for as long as the game runs.
///
/// So this instruction accepts a second, tightly-drawn case: a FINALIZED round with zero
/// participants and no settlement account at all. `participant_count == 0` is what makes it
/// safe — it proves no entrant ever paid a fee into this vault, so there is nothing to
/// distribute and nobody to refund, and the close is only reclaiming the operator's own rent.
/// Any round that took even one entry still has to go through `distribute_pot` or
/// `refund_unrevealed_pot` first, and is rejected here with `RoundHadEntrants`.
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

    /// CHECK: the address is pinned by the seeds below, so nothing else can be presented here.
    /// Its EMPTINESS is the signal (see the handler); the non-empty case is handed straight to
    /// `Account::try_from`, which still checks owner and discriminator before anything is read.
    ///
    /// This was `Account<'info, RoundSettlement>` — typed, so an absent settlement failed on the
    /// discriminator. It cannot stay typed, because Anchor rejects an uninitialized typed account
    /// with `AccountNotInitialized` (3012) BEFORE the handler runs, and "no settlement exists" is
    /// now a legal, closable state for exactly one shape of round.
    ///
    /// It is not a return to the old two-marker probing. That code hand-deserialized two
    /// different accounts to work out WHICH one existed; this reads one account's length to work
    /// out WHETHER it exists, and answers the rest with the typed deserializer as before.
    #[account(
        seeds = [ROUND_SETTLEMENT_SEED, round.round_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub settlement: UncheckedAccount<'info>,

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

    // A vault is closable two ways, and the settlement account tells them apart by whether it
    // exists at all.
    if ctx.accounts.settlement.data_is_empty() {
        // NEVER SETTLED — legal for exactly one shape of round: one that finalized with nobody
        // in it. Such a round can never reach a settlement, so without this it would hold its
        // rent forever. With no entries there is nothing to score, so `scoring_revealed` stays
        // false, so `distribute_pot` refuses it permanently; `refund_unrevealed_pot` can reach
        // it, but it is authority-only and pays a flat per-head figure to zero entrants, which
        // is a multisig ceremony to write a marker saying nothing happened.
        //
        // Nothing is read out of the empty account — only its length is consulted — so a stray
        // lamport transfer to the PDA (which leaves it System-owned with no data) changes
        // nothing here.
        require!(
            ctx.accounts.round.status == ROUND_STATUS_FINALIZED,
            SecretGardenError::PotNotSettled
        );
        // The whole safety of this branch. A round with entrants has real fees in its history
        // and must go through distribute or refund; only `participant_count == 0` proves there
        // were never any entrant funds to account for.
        require_eq!(
            ctx.accounts.round.participant_count,
            0u16,
            SecretGardenError::RoundHadEntrants
        );
        // Deliberately NO `pot_vault.amount == 0` check. It reads like the obvious belt-and-
        // braces and is in fact the griefing vector this instruction already closed once: SPL
        // refuses to close a non-empty account, so requiring emptiness would let one donated
        // base unit wedge an empty round's vault permanently. The sweep below handles it — and
        // with `participant_count == 0` every base unit in there IS surplus by construction,
        // owed to nobody, which is exactly what the sweep is for.
    } else {
        // SETTLED — the original question, asked of the same bytes the typed account read.
        //
        // Deserialized here rather than through `Account::try_from` because `UncheckedAccount`
        // is invariant over its lifetime, so borrowing one back into a typed `Account` forces a
        // named-lifetime signature on this handler and on its call site in `lib.rs`. The two
        // things the typed form gave us are both kept explicitly: `try_deserialize` checks the
        // 8-byte discriminator, and the owner check below is what stops a lookalike account
        // being deserialized as a settlement. (In practice the seeds already guarantee it — only
        // this program can sign for its own PDA, so only this program can have put data there —
        // but the guarantee is worth stating rather than inferring.)
        require_keys_eq!(
            *ctx.accounts.settlement.owner,
            crate::ID,
            SecretGardenError::PotNotSettled
        );
        let data = ctx.accounts.settlement.try_borrow_data()?;
        let settlement = RoundSettlement::try_deserialize(&mut &data[..])?;
        require_eq!(
            settlement.round_id,
            ctx.accounts.round.round_id,
            SecretGardenError::PotNotSettled
        );
        require!(
            settlement.is_terminal(),
            if settlement.state == SETTLEMENT_POT_REFUND_PENDING {
                SecretGardenError::RefundIncomplete
            } else {
                SecretGardenError::PotNotSettled
            }
        );
    }

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
