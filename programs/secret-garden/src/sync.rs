//! Ownership sync — the three duties every sync site owes (design doc §B).
//!
//! Once flowers trade, `FlowerRecord.owner` is a CACHE of who actually holds the NFT, and
//! every instruction that reads it has to reconcile the two first. Under Opsi R the same
//! block also moves the collection counter, because a counter that drifts from ownership is
//! the failure this design exists to prevent.
//!
//! One helper, called identically from all five sites, so the three duties cannot diverge
//! per instruction:
//!
//!   (a) correct `flower.owner` to the real holder;
//!   (b) move `total_flowers`: −1 on the old owner, +1 on the new;
//!   (c) refuse if the new holder has no `PlayerProfile`, rather than skipping (b).
//!
//! # The security property that makes the account list safe
//!
//! `flower_mint` is seeds-derived and ALWAYS required, even for a flower that was never
//! minted. That is not ceremony — it is what stops the sync being skippable.
//!
//! If the mint were optional, a caller could simply omit it and have the instruction fall
//! back to a stale `flower.owner`. Concretely: Alice mints a flower, sells it to Bob, and
//! then calls `start_breeding` passing no mint. The ownership check reads the stale record,
//! sees Alice, and lets her breed with a flower she no longer owns. Requiring the
//! seeds-pinned mint closes that: the caller cannot lie about whether the account exists,
//! because the address is derived from the flower, not supplied.
//!
//! With the mint present, the token account cannot be forged either. Supply is fixed at 1
//! by `create_master_edition_v3(max_supply = Some(0))`, so at most one account on chain can
//! satisfy `mint == flower_mint && amount == 1`, and it is the real holder by definition.
//! A caller who passes anything else fails the check; a caller who passes nothing while the
//! mint exists is refused outright.

use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::{FlowerRecord, PlayerProfile};

/// Adjust one profile's `total_flowers` by ±1, in place.
///
/// Deserialized rather than poked at a byte offset: `try_deserialize` checks the
/// discriminator, so a wrong account fails loudly instead of corrupting whatever it was.
fn bump_total_flowers(info: &AccountInfo, up: bool) -> Result<()> {
    require_keys_eq!(
        *info.owner,
        crate::ID,
        SecretGardenError::ProfileAccountInvalid
    );
    let mut data = info.try_borrow_mut_data()?;
    let mut profile = PlayerProfile::try_deserialize(&mut &data[..])?;
    profile.total_flowers = if up {
        profile.total_flowers.saturating_add(1)
    } else {
        profile.total_flowers.saturating_sub(1)
    };
    profile.try_serialize(&mut &mut data[..])?;
    Ok(())
}

/// Was this flower's NFT burned? — i.e. the mint account still exists but holds no supply.
///
/// `burn_nft` closes the token account, the master edition and all but a marker byte of the
/// metadata, but SPL Token has no close-mint instruction, so the mint itself survives forever
/// with `supply == 0`. That leaves a THIRD state beyond "never minted" and "minted and held",
/// and it is the one that used to brick a flower: the mint is not empty, so the strict path
/// below demanded a token account that the burn had already destroyed.
///
/// Reads the supply straight out of the account rather than deserializing a `Mint`. This module
/// is inlined into `start_breeding`, whose `try_accounts` has already overflowed the 4 KB SBF
/// stack frame once; an 82-byte struct and a deserialize frame is cost worth avoiding for one
/// `u64` at a fixed offset.
///
/// SPL Token `Mint` is a fixed 82-byte layout:
///   `0..4` COption tag for `mint_authority`, `4..36` mint_authority,
///   **`36..44` supply (u64, little-endian)**, `44` decimals, `45` is_initialized,
///   `46..50` COption tag for `freeze_authority`, `50..82` freeze_authority.
///
/// Anything that is not a token-program-owned account of at least that length reports `false`,
/// so an anomalous account falls through to the strict path and is refused there rather than
/// silently skipping the sync. Failing closed is the only safe direction here.
pub(crate) fn nft_was_burned(flower_mint: &AccountInfo) -> Result<bool> {
    if *flower_mint.owner != anchor_spl::token::ID {
        return Ok(false);
    }
    let data = flower_mint.try_borrow_data()?;
    if data.len() < 44 {
        return Ok(false);
    }
    let mut supply = [0u8; 8];
    supply.copy_from_slice(&data[36..44]);
    Ok(u64::from_le_bytes(supply) == 0)
}

/// Reconcile one flower against the chain, doing (a), (b) and (c) together.
///
/// Returns `Ok(())` unchanged when the flower was never minted (it cannot have moved) or
/// when the record already matches the holder (nothing to do). The caller then runs its own
/// ownership check against a `flower.owner` that is now trustworthy.
pub fn sync_flower_owner<'info>(
    flower: &mut Account<'info, FlowerRecord>,
    flower_mint: &UncheckedAccount<'info>,
    flower_token: &UncheckedAccount<'info>,
    previous_profile: &UncheckedAccount<'info>,
    new_profile: &UncheckedAccount<'info>,
) -> Result<()> {
    sync_flower_owner_infos(
        flower,
        &flower_mint.to_account_info(),
        &flower_token.to_account_info(),
        previous_profile,
        new_profile,
    )
}

/// The same reconciliation, taking raw `AccountInfo`s for the mint and token.
///
/// The crank already holds those two as TYPED accounts (it needs `Mint` and `TokenAccount`
/// for its own freeze checks), so it would otherwise have to fabricate `UncheckedAccount`s
/// to call the wrapper. One code path, two entry shapes — the logic is not duplicated.
pub fn sync_flower_owner_infos<'info>(
    flower: &mut Account<'info, FlowerRecord>,
    flower_mint: &AccountInfo<'info>,
    flower_token: &AccountInfo<'info>,
    previous_profile: &UncheckedAccount<'info>,
    new_profile: &UncheckedAccount<'info>,
) -> Result<()> {
    // Never minted: no NFT exists, so no transfer can have happened, so the record is
    // authoritative. This is the common case under lazy minting.
    if flower_mint.data_is_empty() {
        return Ok(());
    }

    // Minted once, then BURNED. Treated exactly like never-minted, and it is safe to do so
    // for a reason the transfer case cannot claim: `burn_flower_nft` requires the signer to be
    // BOTH `flower.owner` and the token's authority, so a burn can only happen while the record
    // and the token already agree. The record was therefore provably correct at the moment of
    // the burn, and with no token left in existence nothing can change hands again. There is no
    // newer owner for the sync to discover.
    //
    // Without this branch a burned flower is bricked rather than merely un-tradeable: the mint
    // is not empty, so the check below demands the token account the burn destroyed, and
    // start_breeding, submit_entry, queue_private_hint and release_flower all refuse it forever
    // with FlowerTokenRequired while it still occupies a collection slot.
    if nft_was_burned(flower_mint)? {
        return Ok(());
    }

    // Minted and still held. The token account is now MANDATORY — see the module note on why
    // omitting it must not be a way to fall back on a stale owner.
    require!(
        !flower_token.data_is_empty(),
        SecretGardenError::FlowerTokenRequired
    );
    require_keys_eq!(
        *flower_token.owner,
        anchor_spl::token::ID,
        SecretGardenError::NotFlowerHolder
    );
    let token: TokenAccount = {
        let data = flower_token.try_borrow_data()?;
        TokenAccount::try_deserialize(&mut &data[..])?
    };
    require_keys_eq!(
        token.mint,
        flower_mint.key(),
        SecretGardenError::WrongFlowerMint
    );
    // Supply is 1, so exactly one account can hold it — this pins the caller to the truth.
    require!(token.amount == 1, SecretGardenError::NotFlowerHolder);

    // Already in sync. No counter movement, no false correction.
    if token.owner == flower.owner {
        return Ok(());
    }

    // --- the flower has changed hands since anyone last looked -----------------------
    //
    // (c) first: refuse rather than skip. A buyer who has never played has no profile, and
    // silently not incrementing would reintroduce exactly the drift Opsi R prevents. One
    // `create_profile` call unblocks them, and they need one to do anything here anyway.
    require!(
        !new_profile.data_is_empty(),
        SecretGardenError::NewOwnerHasNoProfile
    );
    // Both profiles are checked against their PDAs so neither can be substituted: a wrong
    // `new_profile` would otherwise let a caller credit the count to an account of their
    // choosing.
    let (expected_new, _) =
        Pubkey::find_program_address(&[PROFILE_SEED, token.owner.as_ref()], &crate::ID);
    require_keys_eq!(
        new_profile.key(),
        expected_new,
        SecretGardenError::ProfileAccountInvalid
    );
    let (expected_prev, _) =
        Pubkey::find_program_address(&[PROFILE_SEED, flower.owner.as_ref()], &crate::ID);
    require_keys_eq!(
        previous_profile.key(),
        expected_prev,
        SecretGardenError::ProfileAccountInvalid
    );

    // (b) then (a). The previous owner's profile must exist — they held the flower, so they
    // played — but `saturating_sub` means a surprise here under-counts rather than panics.
    bump_total_flowers(previous_profile, false)?;
    bump_total_flowers(new_profile, true)?;
    flower.owner = token.owner;

    // (d) stamp WHEN it changed hands, for the flash-rent cooldown (§E).
    //
    // This sits inside the correction branch on purpose, and the two early returns above are
    // the reason. A never-minted flower and a flower already matching its holder both leave
    // this function before here — correctly, because neither has moved. Stamping at the top
    // instead would mark every ordinary USE as a transfer and lock an owner out of their own
    // flower for a round; stamping nowhere would leave the cooldown with nothing to read.
    //
    // It is the time the change was OBSERVED, not when it happened: under Opsi R a flower
    // that trades and is then left alone carries a stale timestamp until something syncs it.
    // That is benign here, because the first thing to sync it is the very breed the cooldown
    // gates — so the guard sees a fresh stamp exactly when it matters.
    flower.last_transfer_at = Clock::get()?.unix_timestamp;
    Ok(())
}
