use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::metadata::Metadata;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::{CompetitionEntry, CompetitionRound, FlowerRecord, GameConfig, PlayerProfile};

/// Submits one of the player's Active flowers as an entry into an Open round.
///
/// The `entry` PDA is unique per (round, player); a second submission by the same
/// wallet collides on `init` and is rejected structurally — there is no separate
/// duplicate check.
#[derive(Accounts)]
pub struct SubmitEntry<'info> {
    /// The player submitting the entry; funds the entry account.
    #[account(mut)]
    pub player: Signer<'info>,

    /// Game config, read to enforce the pause kill-switch (Stage 5A: this player-facing
    /// instruction previously had no pause gate — added here, logic otherwise unchanged).
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ SecretGardenError::GamePaused,
    )]
    pub config: Account<'info, GameConfig>,

    #[account(
        mut,
        seeds = [PROFILE_SEED, player.key().as_ref()],
        bump = profile.bump,
    )]
    pub profile: Box<Account<'info, PlayerProfile>>,

    /// Target round. The seed check ties the passed account to its stored `round_id`.
    #[account(
        mut,
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
    )]
    pub round: Box<Account<'info, CompetitionRound>>,

    /// Flower being submitted. Ownership and status are validated in the handler, AFTER the
    /// ownership sync below — checking a stale record would accept a seller who no longer
    /// holds the flower.
    #[account(mut)]
    pub flower_record: Box<Account<'info, FlowerRecord>>,

    // --- ownership sync (design doc §B) -------------------------------------------------
    /// CHECK: seeds-pinned, so a caller cannot hide that this flower has an NFT.
    #[account(seeds = [MINT_SEED, flower_record.key().as_ref()], bump)]
    pub flower_mint: UncheckedAccount<'info>,
    /// CHECK: verified in `sync_flower_owner` (mint match + amount == 1).
    ///
    /// MUT because the token lock below WRITES it: `Approve` sets the delegate and Metaplex's
    /// `freeze_delegated_account` flips the account state. It was read-only while the sync was
    /// the only thing touching it; without `mut` the freeze CPI is rejected by the runtime with
    /// "Cross-program invocation with unauthorized signer or writable account" and a bare
    /// "<token pubkey>'s writable privilege escalated". Exactly the bug found in
    /// `start_breeding` during step 4b's devnet verification — same shape, same fix.
    #[account(mut)]
    pub flower_token: UncheckedAccount<'info>,
    /// CHECK: PDA-checked in the helper against the PRE-sync `flower.owner`.
    #[account(mut)]
    pub previous_profile: UncheckedAccount<'info>,
    /// CHECK: PDA-checked in the helper against the real holder.
    ///
    /// The helper's no-profile refusal is reachable here in principle but not in practice:
    /// this instruction already takes the caller's own `profile` above, so a caller without
    /// one fails Anchor's `AccountNotInitialized` before the handler runs. Kept uniform with
    /// the other four sites rather than special-cased — one shape, five call sites.
    #[account(mut)]
    pub new_profile: UncheckedAccount<'info>,

    // --- token lock (design doc §B site table: submit_entry -> SUBMITTED, freeze x1) -------
    //
    // The mint and token accounts are already above, supplied by the sync, so the lock adds
    // only three. All are inert for a never-minted flower: `freeze_flower_if_minted` returns
    // on the mint's emptiness before reading any of them.
    /// CHECK: validated by Metaplex. Holds freeze authority since `create_master_edition_v3`
    /// took it, which is why the lock routes through Metaplex rather than SPL Token.
    pub master_edition: UncheckedAccount<'info>,
    /// The approved delegate, shared by every flower. Signs the freeze CPI via `invoke_signed`.
    ///
    /// MUT is load-bearing: Metaplex declares the delegate `[writable, signer]`.
    /// CHECK: PDA, derived; never deserialized.
    #[account(mut, seeds = [MINT_AUTH_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,
    pub token_metadata_program: Program<'info, Metadata>,

    #[account(
        init,
        payer = player,
        space = 8 + CompetitionEntry::INIT_SPACE,
        seeds = [ENTRY_SEED, round.key().as_ref(), player.key().as_ref()],
        bump,
    )]
    pub entry: Box<Account<'info, CompetitionEntry>>,

    pub system_program: Program<'info, System>,

    // --- $SGD entry fee (Phase 2) ---
    //
    // BOXED, and that is not cosmetic: with these four added, `SubmitEntry::try_accounts`
    // needed a 5,760-byte stack frame against SBF's 4,096-byte limit. That does not fail
    // cleanly — it corrupts the frame and the program dies with "Access violation in unknown
    // section", which looks nothing like an account problem. Boxing moves the deserialized
    // bodies to the heap and brings the frame back under the limit.--------------------------------------------------------
    //
    // Every account below is constrained against `config.sgd_mint` or a program-derived
    // address. That is the point: the classic exploit here is passing a mint and vault the
    // caller controls so the "fee" is paid to themselves. Nothing in this list is free-form.
    /// The configured $SGD mint.
    #[account(constraint = sgd_mint.key() == config.sgd_mint @ SecretGardenError::WrongSgdMint)]
    pub sgd_mint: Box<Account<'info, Mint>>,

    /// The player's own $SGD account, debited by the fee.
    #[account(
        mut,
        constraint = player_sgd_ata.owner == player.key() @ SecretGardenError::WrongSgdMint,
        constraint = player_sgd_ata.mint == config.sgd_mint @ SecretGardenError::WrongSgdMint,
    )]
    pub player_sgd_ata: Box<Account<'info, TokenAccount>>,

    /// This round's pot — always pre-existing. `open_round` creates it, and a round account
    /// cannot exist (so `round.status == OPEN` cannot hold) without `open_round` having run
    /// and completed, so there is no path by which an entry reaches a missing vault. That is
    /// why this is a plain reference and never `init_if_needed`: lazy creation would bill the
    /// round's first entrant rent that nobody else pays.
    ///
    /// PINNED TO THE ASSOCIATED TOKEN ADDRESS in the handler, which is the same guarantee the
    /// `associated_token::` constraint gives the other pot instructions, reached differently.
    ///
    /// The constraint form needs a `pot_authority` account in this struct to point at, and
    /// adding one would change the account list of the single instruction every player sends —
    /// breaking every client build in flight for no security gain, since an ATA's address is a
    /// pure function of (authority, mint) and the handler already derives the authority. The
    /// check there is `require_keys_eq!(pot_vault.key(), get_associated_token_address(..))`,
    /// which is exactly what the constraint expands to.
    ///
    /// This account also stays `Box`ed for the stack-frame reason above; a fifth account here
    /// is precisely what that comment is about.
    #[account(
        mut,
        constraint = pot_vault.mint == config.sgd_mint @ SecretGardenError::WrongSgdMint,
    )]
    pub pot_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub(crate) fn handler(ctx: Context<SubmitEntry>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let player = ctx.accounts.player.key();
    let entry_bump = ctx.bumps.entry;

    // Reconcile before the ownership check, never after.
    crate::sync::sync_flower_owner(
        &mut ctx.accounts.flower_record,
        &ctx.accounts.flower_mint,
        &ctx.accounts.flower_token,
        &ctx.accounts.previous_profile,
        &ctx.accounts.new_profile,
    )?;

    {
        let flower = &ctx.accounts.flower_record;
        require!(flower.owner == player, SecretGardenError::FlowerNotOwned);
        require!(
            flower.status == FLOWER_STATUS_ACTIVE,
            SecretGardenError::FlowerNotActive
        );
    }
    {
        let round = &ctx.accounts.round;
        require!(
            round.status == ROUND_STATUS_OPEN,
            SecretGardenError::RoundNotOpen
        );
        require!(now < round.end_time, SecretGardenError::RoundDeadlinePassed);
        require!(
            round.participant_count < round.max_participants,
            SecretGardenError::RoundFull
        );
    }

    // --- entry fee -------------------------------------------------------------------------
    //
    // Placed AFTER every require! above. Anchor's `init` on `entry` runs before this handler,
    // but a failure anywhere in the instruction reverts the whole transaction — account
    // creation included — so a rejected entry can never leave the player charged. Doing the
    // transfer last also means a doomed submission burns no CPI compute.
    require_keys_neq!(
        ctx.accounts.config.sgd_mint,
        Pubkey::default(),
        SecretGardenError::SgdMintNotSet
    );

    // The vault must be THE round's vault — not merely one its PDA happens to own.
    //
    // Owning-PDA-plus-right-mint was the old test, and anyone can create a non-ATA token account
    // owned by any PDA, so a player could point their fee at a lookalike. That burned their own
    // 100 SGD rather than stealing anyone's, but it broke the invariant the pot depends on:
    // vault balance == participant_count * ENTRY_FEE_SGD. Deriving the ATA address leaves
    // exactly one account that can satisfy this.
    let (expected_pot_authority, _) = Pubkey::find_program_address(
        &[POT_SEED, ctx.accounts.round.round_id.to_le_bytes().as_ref()],
        ctx.program_id,
    );
    require_keys_eq!(
        ctx.accounts.pot_vault.key(),
        get_associated_token_address(&expected_pot_authority, &ctx.accounts.config.sgd_mint),
        SecretGardenError::WrongSgdMint
    );

    // Checked explicitly so an underfunded player gets a named error instead of an opaque
    // SPL Token 0x1 that no UI can explain.
    require!(
        ctx.accounts.player_sgd_ata.amount >= ENTRY_FEE_SGD,
        SecretGardenError::InsufficientEntryFee
    );

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.player_sgd_ata.to_account_info(),
                mint: ctx.accounts.sgd_mint.to_account_info(),
                to: ctx.accounts.pot_vault.to_account_info(),
                authority: ctx.accounts.player.to_account_info(),
            },
        ),
        ENTRY_FEE_SGD,
        ctx.accounts.sgd_mint.decimals,
    )?;

    let round_key = ctx.accounts.round.key();
    let flower_key = ctx.accounts.flower_record.key();

    ctx.accounts.entry.set_inner(CompetitionEntry {
        round: round_key,
        player,
        flower_record: flower_key,
        submitted_at: now,
        status: ENTRY_STATUS_SUBMITTED,
        bump: entry_bump,
        // Stage 4B: scoring fields start empty (filled by score_entry_callback).
        encrypted_score: [0u8; ENTRY_SCORE_LEN],
        score_nonce: [0u8; ENTRY_SCORE_NONCE_LEN],
        scored: false,
        score_error_code: 0,
        // Stage 5A: no scoring computation queued at submission time.
        score_queued: false,
        queued_at: 0,
        // Stage 5E: snapshot the flower's rarity for `reveal_top3_v5`'s tiebreak. Read from
        // the typed `Account<FlowerRecord>` above, which Anchor has already proven is
        // program-owned with the right discriminator, and which this handler has just
        // checked is Active and owned by the signer. Taking it here rather than at reveal
        // time is what keeps the reveal's remaining accounts at n instead of 2n.
        rarity_snapshot: ctx.accounts.flower_record.rarity,
    });

    // Mark the flower used and bump the counters. `participant_count` is guarded above
    // so the increment cannot overflow; `final_submissions` is saturated as a u8 cap.
    ctx.accounts.flower_record.status = FLOWER_STATUS_SUBMITTED;
    ctx.accounts.round.participant_count += 1;
    ctx.accounts.profile.final_submissions =
        ctx.accounts.profile.final_submissions.saturating_add(1);

    // ...and lock it at the TOKEN layer too, for a flower that has been minted.
    //
    // Without this the SUBMITTED flag is advisory once flowers trade. The entry binds the
    // round's payout to `entry.player` by key, so nothing is mis-paid — but a buyer can
    // acquire the flower mid-round with no on-chain signal that its winnings belong to the
    // seller, and a buyer with no `PlayerProfile` blocks `release_flower` for everyone,
    // because the sync's no-profile refusal fires whoever calls it.
    //
    // Runs after the sync and the `flower.owner == player` check above, so `player` is
    // provably the current holder — which is what `Approve` needs as its authority. A
    // never-minted flower, the common case under lazy minting, costs one `data_is_empty()`.
    //
    // No thaw is added anywhere for this. `release_flower` returns the flower to ACTIVE, and
    // the permissionless crank's trigger — ACTIVE + frozen + our delegate — does not care
    // which instruction placed the freeze, so it collects these exactly as it collects
    // post-breed ones.
    crate::freeze::freeze_flower_if_minted(
        crate::freeze::FreezeTarget {
            flower_mint: &ctx.accounts.flower_mint,
            flower_token: &ctx.accounts.flower_token,
            master_edition: &ctx.accounts.master_edition,
        },
        &ctx.accounts.player,
        &ctx.accounts.mint_authority,
        &ctx.accounts.token_program,
        &ctx.accounts.token_metadata_program,
        ctx.bumps.mint_authority,
    )?;

    Ok(())
}
