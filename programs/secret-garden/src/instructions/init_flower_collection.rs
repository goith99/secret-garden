use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::metadata::{
    create_master_edition_v3, create_metadata_accounts_v3,
    mpl_token_metadata::types::{CollectionDetails, DataV2},
    CreateMasterEditionV3, CreateMetadataAccountsV3, Metadata,
};
use anchor_spl::token::{mint_to, Mint, MintTo, Token, TokenAccount};

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::GameConfig;

/// Creates the one Metaplex collection every flower NFT is verified into. Authority-only,
/// and one-shot: the collection mint is `init` at a fixed PDA, so a second call collides.
///
/// Run this BEFORE any `mint_flower_nft` — that instruction's final CPI is
/// `verify_sized_collection_item`, which needs a real, sized collection to point at.
///
/// # Why the mint is a PDA and not a config field
///
/// `[COLLECTION_SEED]` is derivable by anyone, on or off chain, so nothing needs to store
/// it. Storing it in `GameConfig` would also be actively harmful: `migrate_config` only
/// restamps `mutant_weight` when it actually grows the account, and appending a field
/// raises `new_len`, which un-suppresses that early return and lets the next migration
/// reset a live weighting back to `MUTANT_WEIGHT_UNIFORM`. A derived PDA never arms it.
///
/// # `name` / `symbol` / `uri` are arguments here, unlike on the flower NFTs
///
/// They are safe as arguments because this instruction is authority-only — the values can
/// only ever come from the deployment's own key. The per-flower NFTs are the opposite case
/// (anyone may mint their own flower), which is why `mint_flower_nft` derives its name and
/// symbol on chain and accepts only the URI. See the note there.
#[derive(Accounts)]
pub struct InitFlowerCollection<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ SecretGardenError::NotAuthority,
    )]
    pub config: Box<Account<'info, GameConfig>>,

    /// The program's single NFT authority. Mint + freeze authority here, update authority
    /// on the metadata, and the collection authority that verifies members.
    /// CHECK: PDA, derived; never deserialized, only signed with.
    #[account(seeds = [MINT_AUTH_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    /// The collection mint. `init` (not `init_if_needed`) is the one-shot guard.
    #[account(
        init,
        payer = authority,
        seeds = [COLLECTION_SEED],
        bump,
        mint::decimals = 0,
        mint::authority = mint_authority,
        mint::freeze_authority = mint_authority,
    )]
    pub collection_mint: Box<Account<'info, Mint>>,

    /// The collection NFT itself is held by the program, not by a human — so the
    /// collection can never be sold out from under the flowers that reference it.
    #[account(
        init,
        payer = authority,
        associated_token::mint = collection_mint,
        associated_token::authority = mint_authority,
    )]
    pub collection_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: validated by the Metaplex program.
    #[account(mut)]
    pub collection_metadata: UncheckedAccount<'info>,
    /// CHECK: validated by the Metaplex program.
    #[account(mut)]
    pub collection_master_edition: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_metadata_program: Program<'info, Metadata>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub(crate) fn handler(
    ctx: Context<InitFlowerCollection>,
    name: String,
    symbol: String,
    uri: String,
) -> Result<()> {
    require!(uri.len() <= NFT_MAX_URI_LEN, SecretGardenError::UriTooLong);

    let bump = ctx.bumps.mint_authority;
    let signer_seeds: &[&[&[u8]]] = &[&[MINT_AUTH_SEED, &[bump]]];

    // One token, held by the program's own PDA.
    mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.collection_mint.to_account_info(),
                to: ctx.accounts.collection_token_account.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
            signer_seeds,
        ),
        1,
    )?;

    // `collection_details = Some(V1 { size: 0 })` is what makes this a SIZED collection.
    // Without it `verify_sized_collection_item` — the CPI every flower mint ends with —
    // has nothing to increment and fails.
    create_metadata_accounts_v3(
        CpiContext::new_with_signer(
            ctx.accounts.token_metadata_program.key(),
            CreateMetadataAccountsV3 {
                metadata: ctx.accounts.collection_metadata.to_account_info(),
                mint: ctx.accounts.collection_mint.to_account_info(),
                mint_authority: ctx.accounts.mint_authority.to_account_info(),
                payer: ctx.accounts.authority.to_account_info(),
                update_authority: ctx.accounts.mint_authority.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
            },
            signer_seeds,
        ),
        DataV2 {
            name,
            symbol,
            uri,
            seller_fee_basis_points: NFT_SELLER_FEE_BASIS_POINTS,
            creators: None,
            collection: None,
            uses: None,
        },
        true,  // is_mutable — the program keeps update authority, so the URI stays fixable
        true,  // update_authority_is_signer
        Some(CollectionDetails::V1 { size: 0 }),
    )?;

    // Makes the collection a true 1/1 and hands mint+freeze authority to the edition PDA.
    create_master_edition_v3(
        CpiContext::new_with_signer(
            ctx.accounts.token_metadata_program.key(),
            CreateMasterEditionV3 {
                edition: ctx.accounts.collection_master_edition.to_account_info(),
                mint: ctx.accounts.collection_mint.to_account_info(),
                update_authority: ctx.accounts.mint_authority.to_account_info(),
                mint_authority: ctx.accounts.mint_authority.to_account_info(),
                payer: ctx.accounts.authority.to_account_info(),
                metadata: ctx.accounts.collection_metadata.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
            },
            signer_seeds,
        ),
        Some(0),
    )?;
    Ok(())
}
