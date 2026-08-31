use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::{CompetitionRound, GameConfig, RoundSettlement};

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
/// So this refuses unless the current round is FINALIZED and its pot has actually been SETTLED
/// — paid to winners or refunded to entrants — proven by `RoundSettlement` reaching a terminal
/// state. Together those mean nothing denominated in the outgoing mint is still owed.
///
/// # Why settlement and not "the vault is empty"
///
/// The old guard read `old_pot_vault.amount == 0`, and a balance is the wrong kind of evidence
/// twice over.
///
/// It was FORGEABLE. Only the vault's owner and mint were checked, and anyone can create a
/// non-ATA token account owned by any PDA — so an empty lookalike passed the drained test while
/// the real pot sat full, and the mint moved out from under it. The guard existed precisely to
/// stop that outcome and could be walked straight past.
///
/// It was also GRIEFABLE, in the opposite direction. A balance can be raised by anyone: SPL
/// lets any wallet transfer into any token account. One base unit donated into a settled
/// round's vault made `amount == 0` false forever — the pot could not be distributed again (the
/// marker already existed), so nothing could empty it, so the mint could never move. A
/// permissionless, permanent block on a migration path, for the price of dust.
///
/// A settlement marker has neither property. It cannot be created except by the instruction
/// that actually moved the money, it cannot be raised or lowered by a third party, and no
/// donation changes it. The vault account is not passed at all any more: with the marker there
/// is nothing left for it to prove, and an account carried along without a job invites the
/// reader to assume a guarantee it is not providing.
///
/// Older rounds' vaults are still not checked and still cannot be — there is no bounded way to
/// enumerate them on chain. Settle any outstanding pot BEFORE calling this; after it, that pot
/// is unreachable. Sweep the surplus with `close_pot_vault` first too, for the same reason.
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

    /// CHECK: the current round's settlement record. Read raw rather than typed because it is
    /// legitimately ABSENT for a round nobody entered — such a round collects no fees, so
    /// nothing ever creates a settlement for it, and demanding one would block the migration
    /// forever behind a pot that never existed. The handler deserializes it when a round has
    /// entrants and skips it when `participant_count == 0`.
    #[account(seeds = [ROUND_SETTLEMENT_SEED, round.round_id.to_le_bytes().as_ref()], bump)]
    pub settlement: UncheckedAccount<'info>,

    /// The incoming mint. Typed so an unparseable account cannot be pinned.
    pub new_sgd_mint: Account<'info, Mint>,
}

pub(crate) fn handler(ctx: Context<UpdateSgdMint>) -> Result<()> {
    require!(
        ctx.accounts.round.status == ROUND_STATUS_FINALIZED,
        SecretGardenError::RoundNotFinalized
    );

    // Settled, or never had anything to settle. Both are unforgeable: a terminal settlement can
    // only be reached by the instruction that moved the money, and `participant_count` is
    // written by `submit_entry` and never by a caller.
    if ctx.accounts.round.participant_count > 0 {
        require!(
            !ctx.accounts.settlement.data_is_empty(),
            SecretGardenError::PotNotDrained
        );
        let data = ctx.accounts.settlement.try_borrow_data()?;
        let m = RoundSettlement::try_deserialize(&mut &data[..])?;
        require_eq!(
            m.round_id,
            ctx.accounts.round.round_id,
            SecretGardenError::PotNotDrained
        );
        require!(m.is_terminal(), SecretGardenError::PotNotDrained);
    }

    // Same reasoning as `set_sgd_mint`: the fee is a base-unit constant, so the decimals ARE
    // its value. Checked here too because this is the only other way the mint moves.
    require_eq!(
        ctx.accounts.new_sgd_mint.decimals,
        SGD_DECIMALS,
        SecretGardenError::WrongSgdDecimals
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
