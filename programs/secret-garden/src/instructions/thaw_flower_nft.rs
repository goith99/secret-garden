use anchor_lang::prelude::*;
use anchor_spl::metadata::{thaw_delegated_account, Metadata, ThawDelegatedAccount};
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::FlowerRecord;

/// Thaws a flower whose lock has been lifted on chain but whose token is still frozen.
///
/// PERMISSIONLESS, and the second instruction in this program built that way — the first
/// is `release_flower`, which established the pattern. Both finalize a transition the chain
/// has ALREADY earned and then unfreeze the token, and neither asks who is calling, because
/// in both cases the only reachable effect is returning a flower to its own owner's
/// control. One authorization story for the category, not a bespoke rule per instruction.
///
/// # Why this exists at all
///
/// `breed_v5_callback` cannot do the thaw itself. Arcium builds that transaction and it
/// already measures 1,078 of Solana's 1,232 bytes; the five-account Metaplex thaw does not
/// fit in the 154 bytes left, and `multi-tx-callbacks` is disabled at the Arcium program
/// level (error 6212, tested end-to-end on an isolated deployment). So the callback writes
/// the status only, and this instruction completes the job afterwards.
///
/// That split is what creates the design's ACTIVE-but-frozen window: between the callback
/// landing and this running, a flower reads Active but its token is still locked. The
/// client must show that honestly — "unlocking", not "ready" — because a breed or a listing
/// attempted in that window fails at the token layer.
///
/// # How it knows a thaw is due
///
/// Entirely from existing state. No new field, no queue, no marker:
///
///   - `flower.status == FLOWER_STATUS_ACTIVE` — the callback already released it;
///   - the token account is FROZEN — but the lock is still on;
///   - its delegate is `[MINT_AUTH_SEED]` — this program put the lock there.
///
/// ACTIVE + frozen is reachable ONLY through a finished or failed breed whose thaw has not
/// run: a competing flower is SUBMITTED, a breeding one is LOCKED. So the condition cannot
/// be manufactured to thaw something that should still be locked.
///
/// The program signs as the delegate; Metaplex signs the inner SPL `ThawAccount` as the
/// Master Edition PDA, which is the only key that can — it took freeze authority at
/// `create_master_edition_v3`. Neither this program nor the owner can thaw directly, which
/// is why the CPI goes through Metaplex rather than SPL Token.
#[derive(Accounts)]
pub struct ThawFlowerNft<'info> {
    /// Anyone. Pays the transaction fee and nothing else; never an authority here.
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(
        mut,
        constraint = flower.status == FLOWER_STATUS_ACTIVE
            @ SecretGardenError::FlowerNotActive,
    )]
    pub flower: Box<Account<'info, FlowerRecord>>,

    #[account(seeds = [MINT_SEED, flower.key().as_ref()], bump)]
    pub flower_mint: Box<Account<'info, Mint>>,

    // --- ownership sync (design doc §B). The crank already reads the token account, so the
    //     sync costs it two profile accounts and nothing else.
    /// CHECK: PDA-checked in the helper against the PRE-sync `flower.owner`.
    #[account(mut)]
    pub previous_profile: UncheckedAccount<'info>,
    /// CHECK: PDA-checked in the helper against the real holder.
    ///
    /// As in `release_flower`, the helper's no-profile refusal is unreachable here: this
    /// instruction requires the token to be FROZEN, and a frozen token cannot be
    /// transferred, so the holder is whoever started the breed and therefore has a profile.
    /// Left in place so a future change to the freeze mechanism trips the guard rather than
    /// quietly miscounting.
    #[account(mut)]
    pub new_profile: UncheckedAccount<'info>,

    /// The CURRENT holder's token account — not derived from anyone, only checked. The
    /// mint is PDA-pinned to this flower and supply is 1, so at most one account on chain
    /// can hold `amount == 1`, and it is by definition the real holder.
    #[account(
        mut,
        constraint = flower_token.mint == flower_mint.key() @ SecretGardenError::WrongFlowerMint,
        constraint = flower_token.amount == 1 @ SecretGardenError::NotFlowerHolder,
    )]
    pub flower_token: Box<Account<'info, TokenAccount>>,

    /// CHECK: validated by the Metaplex program. Required by anchor-spl's CPI wrapper even
    /// though the raw `ThawDelegatedAccount` instruction does not read it.
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: validated by the Metaplex program. Holds freeze authority since the master
    /// edition was created, which is why the thaw must be routed through Metaplex.
    pub master_edition: UncheckedAccount<'info>,

    /// The approved delegate. Signs the CPI via `invoke_signed`.
    ///
    /// MUT, and not cosmetically: Metaplex declares the delegate `[writable, signer]` on
    /// `ThawDelegatedAccount`. Without `mut` the CPI is rejected by the runtime with
    /// "Cross-program invocation with unauthorized signer or writable account" — a failure
    /// that names neither the account nor the reason.
    /// CHECK: PDA, derived; never deserialized.
    #[account(mut, seeds = [MINT_AUTH_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_metadata_program: Program<'info, Metadata>,
}

pub(crate) fn handler(ctx: Context<ThawFlowerNft>) -> Result<()> {
    // Already thawed is a NAMED refusal, not a silent success. A crank that reports "done"
    // for a flower it did not touch makes an automated caller unable to tell a real thaw
    // from a wasted fee.
    require!(
        ctx.accounts.flower_token.is_frozen(),
        SecretGardenError::FlowerNotFrozen
    );
    // The lock must be OURS. Thawing a freeze this program did not place would be acting
    // outside its own state machine — and Metaplex would refuse it anyway, since the
    // delegate check is what authorises the CPI. Checked here for a clear error.
    require!(
        ctx.accounts.flower_token.delegate.as_ref()
            == anchor_lang::solana_program::program_option::COption::Some(
                ctx.accounts.mint_authority.key()
            )
            .as_ref(),
        SecretGardenError::NotFlowerDelegate
    );

    // The crank is one of the moments a traded flower re-enters use, so it syncs too. It
    // re-reads the token account through the helper rather than reusing the typed one above
    // — one code path for all five sites beats a per-site shortcut.
    let token_info = ctx.accounts.flower_token.to_account_info();
    let mint_info = ctx.accounts.flower_mint.to_account_info();
    crate::sync::sync_flower_owner_infos(
        &mut ctx.accounts.flower,
        &mint_info,
        &token_info,
        &ctx.accounts.previous_profile,
        &ctx.accounts.new_profile,
    )?;

    let bump = ctx.bumps.mint_authority;
    let signer_seeds: &[&[&[u8]]] = &[&[MINT_AUTH_SEED, &[bump]]];

    thaw_delegated_account(CpiContext::new_with_signer(
        ctx.accounts.token_metadata_program.key(),
        ThawDelegatedAccount {
            metadata: ctx.accounts.metadata.to_account_info(),
            delegate: ctx.accounts.mint_authority.to_account_info(),
            token_account: ctx.accounts.flower_token.to_account_info(),
            edition: ctx.accounts.master_edition.to_account_info(),
            mint: ctx.accounts.flower_mint.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        },
        signer_seeds,
    ))?;
    Ok(())
}
