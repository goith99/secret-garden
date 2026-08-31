//! Two-step handover of `GameConfig.authority`.
//!
//! # Why this exists at all
//!
//! It did not. `initialize_config` wrote `authority` once and nothing could ever change it —
//! the admin surface is `add_operator`, `remove_operator`, `set_paused`, `set_mutant_weight`,
//! `set_sgd_mint`, `update_sgd_mint` and `migrate_config`, and not one of them touches it. So
//! the deployment key was permanent: it could not be rotated after a suspected compromise, and
//! it could not be moved behind a multisig. For a key that can pin the fee mint and is the same
//! key holding the program's upgrade authority, "permanent" is the wrong property.
//!
//! # Why two steps
//!
//! Because the failure mode of a one-step transfer is total and silent. `set_authority(addr)`
//! with one wrong character hands the deployment to an address nobody controls, the transaction
//! succeeds, and there is no way back — the only key that could undo it is the one just given
//! away.
//!
//! Requiring the incoming address to SIGN its own acceptance makes that impossible to reach.
//! A mistyped address cannot produce a signature, so it never accepts; the proposal simply sits
//! there, the current authority keeps every power it had, and `cancel_authority_transfer`
//! clears it. The proposal is a nomination, not a transfer — nothing moves until the other side
//! proves it is there.
//!
//! # What a pending proposal does NOT do
//!
//! Nothing. `authority` is unchanged while a proposal is open, so every authority-gated
//! instruction keeps working for the current holder exactly as before, and `is_operator_or_
//! authority` is unaffected. There is no half-transferred state to reason about: control moves
//! in one atomic step, inside `accept_authority_transfer`, or not at all.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::GameConfig;

/// Nominates `new_authority`. Current authority only; changes no permissions by itself.
#[derive(Accounts)]
pub struct ProposeAuthorityTransfer<'info> {
    pub authority: Signer<'info>,

    /// No pause gate: administration must keep working while the game is paused, the same rule
    /// operator management and the migrations follow. Rotating a compromised key is in fact
    /// MORE likely to be needed while paused, since pausing is the first thing you do.
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ SecretGardenError::NotAuthority,
    )]
    pub config: Account<'info, GameConfig>,
}

pub(crate) fn propose_handler(
    ctx: Context<ProposeAuthorityTransfer>,
    new_authority: Pubkey,
) -> Result<()> {
    // The zero address is the "nothing pending" sentinel, so proposing it would be
    // indistinguishable from a cancel — and would look, to anyone reading the config, like no
    // handover had ever been started.
    require_keys_neq!(
        new_authority,
        Pubkey::default(),
        SecretGardenError::InvalidAuthorityProposal
    );
    // Proposing the incumbent is a no-op that would still occupy the pending slot and have to be
    // accepted to clear. Naming it as a mistake beats letting it sit there.
    require_keys_neq!(
        new_authority,
        ctx.accounts.config.authority,
        SecretGardenError::InvalidAuthorityProposal
    );

    // Overwriting an existing proposal is deliberate: re-proposing is how you correct a wrong
    // address without a separate cancel, and only the current authority can do either.
    ctx.accounts.config.pending_authority = new_authority;
    Ok(())
}

/// Completes the handover. Signed by the PROPOSED authority — this signature is the whole
/// safety property.
#[derive(Accounts)]
pub struct AcceptAuthorityTransfer<'info> {
    /// Must equal `config.pending_authority`. Deliberately NOT the current authority: an
    /// address that cannot sign can never receive control, which is what makes a typo harmless.
    pub new_authority: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GameConfig>,
}

pub(crate) fn accept_handler(ctx: Context<AcceptAuthorityTransfer>) -> Result<()> {
    require_keys_neq!(
        ctx.accounts.config.pending_authority,
        Pubkey::default(),
        SecretGardenError::NoPendingAuthority
    );
    require_keys_eq!(
        ctx.accounts.new_authority.key(),
        ctx.accounts.config.pending_authority,
        SecretGardenError::NotPendingAuthority
    );

    // One atomic step: the old key loses everything and the new key gains everything in the same
    // instruction. Clearing the slot in the same breath means a completed transfer leaves no
    // stale proposal that a later reader could mistake for one still in flight.
    ctx.accounts.config.authority = ctx.accounts.config.pending_authority;
    ctx.accounts.config.pending_authority = Pubkey::default();
    Ok(())
}

/// Withdraws a proposal. Current authority only, and only while it is still pending.
#[derive(Accounts)]
pub struct CancelAuthorityTransfer<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ SecretGardenError::NotAuthority,
    )]
    pub config: Account<'info, GameConfig>,
}

pub(crate) fn cancel_handler(ctx: Context<CancelAuthorityTransfer>) -> Result<()> {
    // Named rather than silently idempotent, so "cancel succeeded" always means a real proposal
    // was withdrawn and never "there was nothing there and you were looking at stale state".
    require_keys_neq!(
        ctx.accounts.config.pending_authority,
        Pubkey::default(),
        SecretGardenError::NoPendingAuthority
    );
    ctx.accounts.config.pending_authority = Pubkey::default();
    Ok(())
}
