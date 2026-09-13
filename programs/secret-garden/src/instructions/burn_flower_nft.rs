use anchor_lang::prelude::*;
use anchor_spl::metadata::{burn_nft, BurnNft, Metadata};
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::{FlowerRecord, GameConfig};

/// Burns a flower's NFT and returns the flower to a plain, un-tokenised `FlowerRecord`.
///
/// The inverse of `mint_flower_nft`, and the precondition for `close_flower` on a flower
/// that was ever minted: closing the record while a tradeable token still points at it
/// would leave a buyer holding an NFT backed by nothing.
///
/// Metaplex's `burn_nft` does the whole teardown in one CPI — it burns the supply, closes
/// the token account, and closes the master edition, refunding all of that rent to the
/// owner.
///
/// # What survives the burn, and why the close guard keys on supply
///
/// The MINT ACCOUNT DOES NOT GO AWAY. Legacy SPL Token has no close instruction for mints,
/// so after a burn the mint PDA still exists with `supply == 0` (measured on devnet in two
/// separate spikes). That is exactly why `close_flower` asks `mint.supply == 0` rather than
/// "does the mint PDA exist" — existence would report a burned flower as still minted,
/// permanently, and its record could never be closed.
///
/// The metadata account also survives; Metaplex leaves it. Neither is reclaimable, so a
/// minted-then-burned flower costs slightly more rent than one never minted. That is a
/// property of the token standard, not a choice here.
///
/// # Why this one is NOT permissionless
///
/// Unlike `release_flower` and the thaw crank, burning destroys value. It is owner-only and
/// deliberately so — there is no "the chain already earned this transition" argument to
/// make, because nothing about the chain's state implies a flower's NFT should cease to
/// exist. Only its owner can decide that.
#[derive(Accounts)]
pub struct BurnFlowerNft<'info> {
    /// The flower's owner. Signs the Metaplex burn, and receives the reclaimed rent.
    #[account(mut)]
    pub owner: Signer<'info>,

    /// Pause kill-switch: burning is a player-facing action, and it gates `close_flower`,
    /// which is itself blocked while paused.
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ SecretGardenError::GamePaused,
    )]
    pub config: Box<Account<'info, GameConfig>>,

    /// Must be ACTIVE. A LOCKED or SUBMITTED flower's token is frozen, so the burn would
    /// fail inside SPL Token anyway — this turns that into a named error, and stops a
    /// competing flower being destroyed mid-round.
    #[account(
        constraint = flower.owner == owner.key() @ SecretGardenError::FlowerNotOwned,
        constraint = flower.status == FLOWER_STATUS_ACTIVE
            @ SecretGardenError::FlowerNotActive,
    )]
    pub flower: Box<Account<'info, FlowerRecord>>,

    /// This flower's mint. The seeds are what bind the NFT being burned to THIS flower —
    /// the equivalent of a "the mint matches the record" check, without storing a field.
    #[account(
        mut,
        seeds = [MINT_SEED, flower.key().as_ref()],
        bump,
        constraint = mint.supply == 1 @ SecretGardenError::FlowerNotMinted,
    )]
    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = owner,
        constraint = token_account.amount == 1 @ SecretGardenError::FlowerNotMinted,
    )]
    pub token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: validated by the Metaplex program.
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: validated by the Metaplex program.
    #[account(mut)]
    pub master_edition: UncheckedAccount<'info>,

    /// Required because every flower NFT is a VERIFIED collection item: `burn_nft` has to
    /// decrement the sized collection's count, and refuses without it.
    /// CHECK: validated by the Metaplex program; pinned to the collection mint's metadata.
    #[account(mut)]
    pub collection_metadata: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_metadata_program: Program<'info, Metadata>,
}

pub(crate) fn handler(ctx: Context<BurnFlowerNft>) -> Result<()> {
    burn_nft(
        CpiContext::new(
            ctx.accounts.token_metadata_program.key(),
            BurnNft {
                metadata: ctx.accounts.metadata.to_account_info(),
                owner: ctx.accounts.owner.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                token: ctx.accounts.token_account.to_account_info(),
                edition: ctx.accounts.master_edition.to_account_info(),
                spl_token: ctx.accounts.token_program.to_account_info(),
            },
        )
        // `burn_nft` takes the collection metadata as an ARGUMENT but reads it from the
        // account list, so it has to ride along as a remaining account.
        .with_remaining_accounts(vec![ctx.accounts.collection_metadata.to_account_info()]),
        Some(ctx.accounts.collection_metadata.key()),
    )?;
    Ok(())
}
