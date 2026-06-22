use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::{FlowerRecord, GameConfig, PlayerProfile};

/// Grants the caller their six starter flowers in a single instruction — i.e. a single
/// wallet approval. Initializing all six `FlowerRecord` PDAs here references only ten
/// accounts total (owner, config, profile, system program, six flowers), which is well
/// within Solana's per-transaction account and size limits, so the single-approval
/// design requirement holds.
#[derive(Accounts)]
pub struct ClaimStarters<'info> {
    /// Wallet that owns (and funds) the new flowers.
    #[account(mut)]
    pub owner: Signer<'info>,

    /// Game config, read to enforce the pause kill-switch.
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ SecretGardenError::GamePaused,
    )]
    pub config: Account<'info, GameConfig>,

    /// Caller's profile. Must exist, belong to the signer, and not have claimed yet.
    ///
    /// The `starter_claimed` guard is the semantic one-time gate. Note that the six
    /// flower PDAs below are also unique, so a real re-claim additionally collides on
    /// `init` ("account already in use"); both reject the duplicate transaction.
    #[account(
        mut,
        seeds = [PROFILE_SEED, owner.key().as_ref()],
        bump = profile.bump,
        has_one = owner,
        constraint = !profile.starter_claimed @ SecretGardenError::StartersAlreadyClaimed,
    )]
    pub profile: Account<'info, PlayerProfile>,

    // One FlowerRecord per species, keyed by flower_index 0..=5 in little-endian bytes.
    #[account(
        init,
        payer = owner,
        space = 8 + FlowerRecord::INIT_SPACE,
        seeds = [FLOWER_SEED, owner.key().as_ref(), &0u32.to_le_bytes()],
        bump,
    )]
    pub flower_0: Box<Account<'info, FlowerRecord>>,
    #[account(
        init,
        payer = owner,
        space = 8 + FlowerRecord::INIT_SPACE,
        seeds = [FLOWER_SEED, owner.key().as_ref(), &1u32.to_le_bytes()],
        bump,
    )]
    pub flower_1: Box<Account<'info, FlowerRecord>>,
    #[account(
        init,
        payer = owner,
        space = 8 + FlowerRecord::INIT_SPACE,
        seeds = [FLOWER_SEED, owner.key().as_ref(), &2u32.to_le_bytes()],
        bump,
    )]
    pub flower_2: Box<Account<'info, FlowerRecord>>,
    #[account(
        init,
        payer = owner,
        space = 8 + FlowerRecord::INIT_SPACE,
        seeds = [FLOWER_SEED, owner.key().as_ref(), &3u32.to_le_bytes()],
        bump,
    )]
    pub flower_3: Box<Account<'info, FlowerRecord>>,
    #[account(
        init,
        payer = owner,
        space = 8 + FlowerRecord::INIT_SPACE,
        seeds = [FLOWER_SEED, owner.key().as_ref(), &4u32.to_le_bytes()],
        bump,
    )]
    pub flower_4: Box<Account<'info, FlowerRecord>>,
    #[account(
        init,
        payer = owner,
        space = 8 + FlowerRecord::INIT_SPACE,
        seeds = [FLOWER_SEED, owner.key().as_ref(), &5u32.to_le_bytes()],
        bump,
    )]
    pub flower_5: Box<Account<'info, FlowerRecord>>,

    pub system_program: Program<'info, System>,
}

/// Writes the immutable Stage 1 fields for one starter flower, sourcing its cosmetic
/// attributes from the compile-time `SPECIES` table.
fn populate_flower(
    flower: &mut Account<FlowerRecord>,
    owner: Pubkey,
    flower_index: u32,
    created_at: i64,
    bump: u8,
) -> Result<()> {
    let species = SPECIES
        .get(flower_index as usize)
        .ok_or(error!(SecretGardenError::InvalidSpecies))?;

    flower.set_inner(FlowerRecord {
        owner,
        flower_index,
        visual_species_id: species.visual_species_id,
        generation: 0,
        rarity: species.rarity,
        stability: STARTER_STABILITY,
        revealed_trait_mask: species.revealed_trait_mask,
        parent_a: Pubkey::default(),
        parent_b: Pubkey::default(),
        genome_status: GENOME_STATUS_STARTER,
        source_experiment: Pubkey::default(),
        status: FLOWER_STATUS_ACTIVE,
        created_at,
        bump,
        // Stage 3A: starters carry no encrypted genome (derived from species).
        genome_commitment: [0u8; GENOME_COMMITMENT_LEN],
        encrypted_genome: [0u8; ENCRYPTED_GENOME_LEN],
        encryption_metadata: [0u8; ENCRYPTION_METADATA_LEN],
    });
    Ok(())
}

pub(crate) fn handler(ctx: Context<ClaimStarters>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let owner = ctx.accounts.owner.key();

    // Copy bumps out before taking mutable borrows of the account fields.
    let bumps = [
        ctx.bumps.flower_0,
        ctx.bumps.flower_1,
        ctx.bumps.flower_2,
        ctx.bumps.flower_3,
        ctx.bumps.flower_4,
        ctx.bumps.flower_5,
    ];

    populate_flower(&mut ctx.accounts.flower_0, owner, 0, now, bumps[0])?;
    populate_flower(&mut ctx.accounts.flower_1, owner, 1, now, bumps[1])?;
    populate_flower(&mut ctx.accounts.flower_2, owner, 2, now, bumps[2])?;
    populate_flower(&mut ctx.accounts.flower_3, owner, 3, now, bumps[3])?;
    populate_flower(&mut ctx.accounts.flower_4, owner, 4, now, bumps[4])?;
    populate_flower(&mut ctx.accounts.flower_5, owner, 5, now, bumps[5])?;

    let profile = &mut ctx.accounts.profile;
    profile.starter_claimed = true;
    profile.total_flowers = STARTER_COUNT as u16;
    // Starters occupy flower indices 0..=5; bred offspring continue from here.
    profile.next_flower_index = STARTER_COUNT as u32;

    Ok(())
}
