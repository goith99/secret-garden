use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::metadata::{
    create_master_edition_v3, create_metadata_accounts_v3,
    mpl_token_metadata::types::{Collection, DataV2},
    verify_sized_collection_item, CreateMasterEditionV3, CreateMetadataAccountsV3, Metadata,
    VerifySizedCollectionItem,
};
use anchor_spl::token::{mint_to, Mint, MintTo, Token, TokenAccount};

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::{FlowerRecord, GameConfig};

/// Mints one flower as a Metaplex NFT, verified into the program's collection.
///
/// LAZY and OPT-IN: flowers are plain PDAs until a player decides to list one. That is not
/// only a preference. `claim_starters` structurally CANNOT mint inline — six NFTs needs
/// roughly 42 accounts, about 1,344 bytes of keys against Solana's 1,232-byte transaction
/// limit — and `breed_v5_callback` cannot create accounts at all (Arcium callbacks never
/// can; the offspring is pre-created in `start_breeding` for exactly that reason). Keeping
/// it opt-in also keeps ~0.069 SOL of mainnet rent off the onboarding path for six starters
/// most players will never trade.
///
/// # Two guards, for two different reasons
///
///   - `status == FLOWER_STATUS_ACTIVE` — a SUBMITTED flower is mid-competition. Minting
///     one would produce an unfrozen, immediately sellable NFT while the flower is still
///     committed to a live round, and the buyer would inherit a flower that its entry can
///     no longer release.
///   - `genome_status == GENOME_STATUS_ENCRYPTED` — hybrids only; starters are never
///     mintable. Starters arrive free from `claim_starters` with no breeding behind them,
///     so a sellable starter is an instant cash-out that never touches the game's core
///     loop. It also keeps the collection cap honest: the
///     `total_flowers - STARTER_COUNT == live hybrid count` invariant assumes the six
///     starters never leave the wallet that claimed them.
///
/// # Why `uri` is an argument, and why `name`/`symbol` are not
///
/// The URI cannot be derived on chain. The metadata JSON and the rendered image are
/// uploaded to permanent storage BEFORE this runs, and content-addressed storage hands
/// back an id that is unknowable until the upload completes — so the program cannot
/// predict it, and cannot require a deterministic value.
///
/// That leaves the URI caller-supplied, which is worth being precise about rather than
/// hand-waving. What a caller CANNOT do: mint someone else's flower (`flower.owner`),
/// mint the same flower twice (`init` on a PDA keyed to the flower), or bring a
/// collection-verified NFT into existence that is not backed by a real `FlowerRecord`
/// (the mint address is derived from one). Collection membership is therefore never
/// forgeable — the verified badge means "this is a genuine Secret Garden flower", and
/// that stays true even for a caller who lies.
///
/// What a caller CAN do is point their own flower's metadata at JSON that misdescribes it.
/// Three things bound that, short of the permissioned mint an on-chain URI check would
/// require:
///   1. `name` and `symbol` are derived HERE, not supplied, so the NFT cannot be titled
///      into something it is not;
///   2. the program keeps `update_authority` (`[MINT_AUTH_SEED]`), so bad metadata is
///      correctable after the fact with `update_metadata_accounts_v2`;
///   3. every attribute worth lying about — rarity, generation, species, trait mask — is
///      PLAINTEXT on chain, so the mismatch is detectable by anyone who looks.
///
/// The residual risk is a buyer on a third-party marketplace who trusts attributes without
/// checking chain state, deceived by the flower's own owner. That is the same risk every
/// collection with creator-supplied metadata carries, and it is disclosed rather than
/// designed away.
#[derive(Accounts)]
pub struct MintFlowerNft<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ SecretGardenError::GamePaused,
    )]
    pub config: Box<Account<'info, GameConfig>>,

    #[account(
        constraint = flower.owner == owner.key() @ SecretGardenError::FlowerNotOwned,
        constraint = flower.status == FLOWER_STATUS_ACTIVE
            @ SecretGardenError::FlowerNotActive,
        constraint = flower.genome_status == GENOME_STATUS_ENCRYPTED
            @ SecretGardenError::StarterNotMintable,
    )]
    pub flower: Box<Account<'info, FlowerRecord>>,

    /// CHECK: PDA, derived; never deserialized, only signed with.
    #[account(seeds = [MINT_AUTH_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    /// This flower's mint. Keyed to the FLOWER PDA, so it is globally unique and stable.
    /// `init` is also the idempotency guard — a second mint of the same flower collides
    /// with "account already in use", which is why no `FlowerRecord` field is needed to
    /// record that a flower has been minted.
    #[account(
        init,
        payer = owner,
        seeds = [MINT_SEED, flower.key().as_ref()],
        bump,
        mint::decimals = 0,
        mint::authority = mint_authority,
        mint::freeze_authority = mint_authority,
    )]
    pub mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = owner,
    )]
    pub token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: validated by the Metaplex program.
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: validated by the Metaplex program.
    #[account(mut)]
    pub master_edition: UncheckedAccount<'info>,

    #[account(seeds = [COLLECTION_SEED], bump)]
    pub collection_mint: Box<Account<'info, Mint>>,
    /// CHECK: validated by the Metaplex program.
    #[account(mut)]
    pub collection_metadata: UncheckedAccount<'info>,
    /// CHECK: validated by the Metaplex program.
    pub collection_master_edition: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_metadata_program: Program<'info, Metadata>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub(crate) fn handler(ctx: Context<MintFlowerNft>, uri: String) -> Result<()> {
    require!(uri.len() <= NFT_MAX_URI_LEN, SecretGardenError::UriTooLong);

    let bump = ctx.bumps.mint_authority;
    let signer_seeds: &[&[&[u8]]] = &[&[MINT_AUTH_SEED, &[bump]]];

    // Derived, never supplied. "SG Hybrid #" + up to 10 digits = 21 bytes, inside
    // Metaplex's 32-byte MAX_NAME_LENGTH at every reachable index.
    let name = format!("{}{}", NFT_NAME_PREFIX, ctx.accounts.flower.flower_index);

    mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.token_account.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
            signer_seeds,
        ),
        1,
    )?;

    // `verified: false` here — a member cannot verify itself. The final CPI below is what
    // flips it, signed by the collection authority.
    create_metadata_accounts_v3(
        CpiContext::new_with_signer(
            ctx.accounts.token_metadata_program.key(),
            CreateMetadataAccountsV3 {
                metadata: ctx.accounts.metadata.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                mint_authority: ctx.accounts.mint_authority.to_account_info(),
                payer: ctx.accounts.owner.to_account_info(),
                update_authority: ctx.accounts.mint_authority.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
            },
            signer_seeds,
        ),
        DataV2 {
            name,
            symbol: NFT_SYMBOL.to_string(),
            uri,
            seller_fee_basis_points: NFT_SELLER_FEE_BASIS_POINTS,
            creators: None,
            collection: Some(Collection {
                verified: false,
                key: ctx.accounts.collection_mint.key(),
            }),
            uses: None,
        },
        true, // is_mutable — keeps the correction path in (2) above open
        true, // update_authority_is_signer
        None, // collection_details: this is a MEMBER, not a collection
    )?;

    // max_supply = Some(0) makes it a true 1/1: no editions can ever be printed from it.
    // This is also the call that moves mint AND freeze authority to the Master Edition PDA
    // (measured on devnet, spike #1) — which is why the later lock design freezes through
    // Metaplex's delegate path rather than SPL Token directly.
    create_master_edition_v3(
        CpiContext::new_with_signer(
            ctx.accounts.token_metadata_program.key(),
            CreateMasterEditionV3 {
                edition: ctx.accounts.master_edition.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                update_authority: ctx.accounts.mint_authority.to_account_info(),
                mint_authority: ctx.accounts.mint_authority.to_account_info(),
                payer: ctx.accounts.owner.to_account_info(),
                metadata: ctx.accounts.metadata.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
            },
            signer_seeds,
        ),
        Some(0),
    )?;

    // The badge. Signed by [MINT_AUTH_SEED], which is the collection's update authority —
    // the caller cannot produce this signature, which is what makes membership unforgeable
    // no matter what URI they passed.
    verify_sized_collection_item(
        CpiContext::new_with_signer(
            ctx.accounts.token_metadata_program.key(),
            VerifySizedCollectionItem {
                payer: ctx.accounts.owner.to_account_info(),
                metadata: ctx.accounts.metadata.to_account_info(),
                collection_authority: ctx.accounts.mint_authority.to_account_info(),
                collection_mint: ctx.accounts.collection_mint.to_account_info(),
                collection_metadata: ctx.accounts.collection_metadata.to_account_info(),
                collection_master_edition: ctx
                    .accounts
                    .collection_master_edition
                    .to_account_info(),
            },
            signer_seeds,
        ),
        None,
    )?;
    Ok(())
}
