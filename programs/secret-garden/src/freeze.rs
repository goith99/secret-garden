//! Token locking for flowers taken out of circulation (design doc §A, §B site table).
//!
//! A flower the program has taken out of circulation — LOCKED by `start_breeding` or
//! SUBMITTED by `submit_entry` — must also be locked at the token layer, or the status flag
//! means nothing once flowers are tradeable.
//!
//! For breeding the harm is direct: the owner could sell the NFT out from under an in-flight
//! computation, the record would name a seller who no longer holds it, and
//! `breed_v5_callback` would release the flower to the wrong person. For a competition entry
//! the harm is subtler but real: `CompetitionEntry` binds the round's payout to
//! `entry.player` by key, so a buyer can acquire a flower mid-round with no on-chain signal
//! that its winnings belong to the seller, and — if the buyer has no `PlayerProfile` — the
//! sync's no-profile refusal blocks `release_flower` for everyone until they create one.
//!
//! # Why the lock goes through Metaplex rather than SPL Token
//!
//! `create_master_edition_v3` moves BOTH mint and freeze authority to the Master Edition
//! PDA (spike S1, measured). That PDA is Metaplex-owned and its seeds resolve under
//! Metaplex's program ID, so this program can never `invoke_signed` as it — a direct SPL
//! `freeze_account` fails `0x4 owner does not match`. The only route left is Metaplex's
//! `freeze_delegated_account`, which authorises on the token's DELEGATE and signs the inner
//! SPL freeze as the edition itself. This program's `[MINT_AUTH_SEED]` PDA is that delegate.
//!
//! # Approve is conditional, not unconditional
//!
//! The delegate SURVIVES a thaw (spike S2): only an explicit `Revoke` clears it. So a flower
//! bred once already carries this program as delegate, and re-approving every breed would
//! burn a CPI to write a value that is already there. `Approve` is therefore issued only
//! when the delegate is missing, points somewhere else, or has a spent allowance — which
//! also transparently handles the revoke-then-breed case: an owner who revoked between
//! breeds is silently re-approved on their next one, because they are signing that
//! transaction anyway.
//!
//! # The common case costs almost nothing
//!
//! Under lazy minting most flowers have no mint at all, and the whole helper exits on a
//! single `data_is_empty()` check before touching the token account or either CPI.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::metadata::{freeze_delegated_account, FreezeDelegatedAccount, Metadata};
use anchor_spl::token::{approve, Approve, Token, TokenAccount};

use crate::constants::*;
use crate::error::SecretGardenError;

/// Accounts the lock needs for ONE flower, grouped so a caller can hand over a set (or two,
/// in `start_breeding`'s case) without an eleven-argument call.
pub struct FreezeTarget<'a, 'info> {
    pub flower_mint: &'a UncheckedAccount<'info>,
    pub flower_token: &'a UncheckedAccount<'info>,
    pub master_edition: &'a UncheckedAccount<'info>,
}

/// Freeze one flower's NFT for as long as the program holds it, approving the delegate first
/// if this program does not already hold it.
///
/// A no-op for a flower that was never minted — the common case, and the reason this is
/// written as an early return rather than a branch inside the CPI block.
///
/// `owner` must already be the verified holder: every call site runs `sync_flower_owner` and
/// its own `flower.owner == player` check BEFORE calling this, so by here the signer is
/// provably the person `Approve` needs as authority.
#[allow(clippy::too_many_arguments)]
pub fn freeze_flower_if_minted<'info>(
    target: FreezeTarget<'_, 'info>,
    owner: &Signer<'info>,
    mint_authority: &UncheckedAccount<'info>,
    token_program: &Program<'info, Token>,
    token_metadata_program: &Program<'info, Metadata>,
    mint_auth_bump: u8,
) -> Result<()> {
    // Never minted: there is no token to lock, and the program-state LOCKED flag is the
    // whole lock. Exits before any deserialization or CPI.
    if target.flower_mint.data_is_empty() {
        return Ok(());
    }

    // Minted, so the token account is mandatory — same rule, and the same reason, as the
    // sync helper's. `sync_flower_owner` has already enforced this for both parents by the
    // time we get here; repeated so this function is correct if ever called elsewhere.
    require!(
        !target.flower_token.data_is_empty(),
        SecretGardenError::FlowerTokenRequired
    );
    require_keys_eq!(
        *target.flower_token.owner,
        anchor_spl::token::ID,
        SecretGardenError::NotFlowerHolder
    );
    let token: TokenAccount = {
        let data = target.flower_token.try_borrow_data()?;
        TokenAccount::try_deserialize(&mut &data[..])?
    };
    require_keys_eq!(
        token.mint,
        target.flower_mint.key(),
        SecretGardenError::WrongFlowerMint
    );
    require!(token.amount == 1, SecretGardenError::NotFlowerHolder);

    // Already frozen. Reachable through the design's ACTIVE-but-frozen window — a previous
    // breed finished and `thaw_flower_nft` has not been cranked yet — so it is a legitimate
    // state, not an error. The token is locked, which is what this function is for, and
    // re-freezing would fail inside Metaplex. Nothing to do.
    //
    // It matters that this returns BEFORE the approve branch: `Approve` on a frozen account
    // fails `0x11 Account is frozen`, so checking the delegate first would turn a benign
    // state into a hard failure.
    if token.is_frozen() {
        return Ok(());
    }

    let signer_seeds: &[&[&[u8]]] = &[&[MINT_AUTH_SEED, &[mint_auth_bump]]];

    // Approve only when we do not already hold a usable delegation. The delegate outlives a
    // thaw, so the steady state for a repeat breeder is to skip this entirely.
    let holds_delegation = token.delegate == COption::Some(mint_authority.key())
        && token.delegated_amount >= 1;
    if !holds_delegation {
        approve(
            CpiContext::new(
                token_program.key(),
                Approve {
                    to: target.flower_token.to_account_info(),
                    delegate: mint_authority.to_account_info(),
                    authority: owner.to_account_info(),
                },
            ),
            1,
        )?;
    }

    freeze_delegated_account(CpiContext::new_with_signer(
        token_metadata_program.key(),
        FreezeDelegatedAccount {
            // Unused by Metaplex (see the account comment in `StartBreeding`); the wrapper
            // needs an AccountInfo here, so reuse one already in the transaction.
            metadata: target.flower_mint.to_account_info(),
            delegate: mint_authority.to_account_info(),
            token_account: target.flower_token.to_account_info(),
            edition: target.master_edition.to_account_info(),
            mint: target.flower_mint.to_account_info(),
            token_program: token_program.to_account_info(),
        },
        signer_seeds,
    ))?;

    Ok(())
}
