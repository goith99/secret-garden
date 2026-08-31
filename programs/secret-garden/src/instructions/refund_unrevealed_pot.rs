use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::{CompetitionEntry, CompetitionRound, GameConfig, RoundSettlement};

/// Hands an UNREVEALED round's pot back to the players who funded it.
///
/// # The hole this closes
///
/// `distribute_pot` requires `round.scoring_revealed`, and that flag is written in exactly two
/// places — `apply_bracket_result` and `reveal_top3_v5_callback` — both of which need real
/// Arcium MPC output. No operator, and not the authority, can set it by hand. But
/// `finalize_round` has never required a reveal, so a round can legitimately reach FINALIZED
/// with `scoring_revealed == false` and stay there forever. Before this instruction existed,
/// such a round's pot could not be paid (no reveal), could not be refunded (no path), and
/// could not even have its vault closed (`close_pot_vault` demands a distribution marker).
/// The players' fees were simply gone, held by a PDA nothing was authorised to move.
///
/// That is not a hypothetical failure: rounds already sit in exactly this state, and the whole
/// class of it is one Arcium outage wide.
///
/// # Why the entrants and not the treasury
///
/// A lump-sum sweep to the treasury would have been perhaps a third of this code — one
/// transfer, an immutable marker, no cursor, no batching. It was rejected because the money is
/// not the operator's. An unrevealed round is one where the game FAILED TO RUN: nobody won,
/// because nothing was ever scored. Every lamport in that vault arrived as an entry fee from a
/// player who was promised a competition and did not get one. Paying it to the house on the
/// grounds that the house's code broke is the wrong default, and it is the one that becomes
/// indefensible the moment this runs on mainnet with real money.
///
/// Each entrant gets back exactly `ENTRY_FEE_SGD` — the amount they paid — and NOT a share of
/// the vault.
///
/// The difference matters. Paying out shares means the payout depends on the vault balance,
/// and the vault balance is something anyone can change: SPL lets any wallet transfer into any
/// token account. An earlier version of this handler gave the truncation remainder AND any
/// donation to whichever entrant sorted last in the cursor order, which made a failed round's
/// pot worth grinding a vanity address for — sort last, wait for a large donation, collect all
/// of it. Not cheap to pull off, but the payout of an escape hatch should not be a function of
/// anyone's pubkey.
///
/// A flat per-head figure removes the dependency entirely. Every entrant is owed the same fixed
/// number regardless of vault balance, batch composition, cursor position, or when a donation
/// lands relative to the batches. Two entrants in the same round cannot receive different
/// amounts, and no reordering changes anyone's total.
///
/// Whatever is left over — donations, and the shortfall remainder in the degenerate case below
/// — is SURPLUS: owed to nobody, recorded on the settlement, and left in the vault for
/// `close_pot_vault` to sweep to the authority as unclaimed. Leaving it is deliberate rather
/// than lazy: any rule for splitting it among entrants reintroduces exactly the dependency the
/// flat fee just removed, and the sweep destination is `config.authority`, which no ordering,
/// batch shape, or caller can influence.
///
/// # Why this is batched
///
/// A round can hold `ROUND_CAPACITY` entries, and each refund needs two accounts: the entry
/// (the only on-chain record of WHO paid — the vault knows amounts, not payers) and that
/// player's token account. The account list runs out long before the entrants do, so the work
/// spans several calls and `PotRefund` carries the state between them. Call it repeatedly with
/// the next slice of entrants until `completed_at` is non-zero.
///
/// Ordering is the guard against double payment. Entries must arrive in strictly ascending
/// pubkey order across the WHOLE refund, checked against `PotRefund::cursor`, which makes
/// revisiting an entry structurally impossible without a per-entrant bitmap that would grow
/// this account with round size. Skipping an entrant is possible and is not silently absorbed:
/// the refund can then never reach `entrant_count`, so it never completes and the vault never
/// drains, which is a visible stuck state rather than a payment sent to the wrong person.
#[derive(Accounts)]
pub struct RefundUnrevealedPot<'info> {
    /// The authority, and ONLY the authority. `distribute_pot` and `close_pot_vault` accept any
    /// operator because they pay a result the chain already agreed on; this one decides that a
    /// round's competition never happened, which is a judgement call and belongs to the key
    /// that owns the deployment.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Not pause-gated, for the same reason as `distribute_pot`: this winds down a round that
    /// is already over, and stranding players' fees behind a pause would be strictly worse
    /// than letting the refund land.
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ SecretGardenError::NotAuthority,
    )]
    pub config: Account<'info, GameConfig>,

    /// Seed-checked against its own stored id, so the caller cannot present round X's account
    /// while the vault and markers derive from round Y.
    #[account(
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
    )]
    pub round: Account<'info, CompetitionRound>,

    /// THE settlement state, and the only thing consulted about whether this pot is spoken for.
    ///
    /// `init_if_needed` because a refund is resumed across batches — the first call creates it,
    /// every later one reads the state and cursor back. Safe despite the footgun reputation: it
    /// is a PDA with fixed seeds, so exactly one account can satisfy them, and the handler
    /// distinguishes a fresh (zeroed) account from a live one by `round_id == 0` rather than by
    /// re-running initialization blindly.
    ///
    /// This single account replaced the pair of probes that used to live here — a `PotRefund`
    /// marker plus an `UncheckedAccount` pointed at `PotDistribution` purely to prove it did not
    /// exist. Mutual exclusion is now a property of the state machine instead of two checks
    /// that had to agree.
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + RoundSettlement::INIT_SPACE,
        seeds = [ROUND_SETTLEMENT_SEED, round.round_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub settlement: Account<'info, RoundSettlement>,

    /// CHECK: the vault's authority PDA. Derived, so no keypair for it exists and the program
    /// signing with these seeds is the only way the pot can move. Never deserialized.
    #[account(seeds = [POT_SEED, round.round_id.to_le_bytes().as_ref()], bump)]
    pub pot_authority: UncheckedAccount<'info>,

    /// The round's pot, PINNED TO THE ASSOCIATED TOKEN ACCOUNT rather than merely checked for
    /// owner and mint.
    ///
    /// This is the audit's account-substitution finding, fixed here at the point of writing
    /// instead of inherited. Owner-and-mint alone is not enough: anyone can create a non-ATA
    /// token account owned by any PDA, so a second account satisfying both checks can always be
    /// made to exist. Against a refund that would be severe — an empty decoy would drive the
    /// entrant count to completion while paying nobody, and stamp `completed_at` on a pot that
    /// is still full. `associated_token::` narrows the set of accounts that can satisfy this to
    /// exactly one, the vault `open_round` created.
    #[account(
        mut,
        associated_token::mint = sgd_mint,
        associated_token::authority = pot_authority,
    )]
    pub pot_vault: Account<'info, TokenAccount>,

    #[account(constraint = sgd_mint.key() == config.sgd_mint @ SecretGardenError::WrongSgdMint)]
    pub sgd_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn handler<'info>(ctx: Context<'info, RefundUnrevealedPot<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let round_id = ctx.accounts.round.round_id;

    // --- eligibility -----------------------------------------------------------------------
    require!(
        ctx.accounts.round.status == ROUND_STATUS_FINALIZED,
        SecretGardenError::RoundNotFinalized
    );
    // The load-bearing one. A revealed round has winners with a real claim on the pot, and
    // `distribute_pot` is the only thing allowed to act on that claim.
    require!(
        !ctx.accounts.round.scoring_revealed,
        SecretGardenError::RoundAlreadyRevealed
    );
    require!(
        now >= ctx
            .accounts
            .round
            .end_time
            .checked_add(POT_REFUND_MIN_AGE_SECONDS)
            .ok_or(SecretGardenError::PotMathOverflow)?,
        SecretGardenError::RefundTooEarly
    );
    require_keys_neq!(
        ctx.accounts.config.sgd_mint,
        Pubkey::default(),
        SecretGardenError::SgdMintNotSet
    );

    // --- settlement state gate ----------------------------------------------------------------
    //
    // One read, and it covers every case the two separate probes used to: a pot already paid to
    // winners, a refund already finished, and — new here — a refund that another transaction has
    // started but not finished. That last one was previously unguarded in this direction,
    // because a half-built `PotRefund` marker did not yet mean the pot was spoken for.
    let fresh = ctx.accounts.settlement.round_id == 0;
    if fresh {
        ctx.accounts.settlement.round_id = round_id;
        ctx.accounts.settlement.bump = ctx.bumps.settlement;
        ctx.accounts.settlement.state = SETTLEMENT_NONE;
    } else {
        // Unreachable while the seeds hold, and asserted anyway: the cost of being wrong here is
        // paying the wrong round's entrants.
        require_eq!(
            ctx.accounts.settlement.round_id,
            round_id,
            SecretGardenError::EntryWrongRound
        );
    }
    match ctx.accounts.settlement.state {
        SETTLEMENT_NONE | SETTLEMENT_POT_REFUND_PENDING => {}
        SETTLEMENT_POT_PAID => return Err(SecretGardenError::PotAlreadyDistributed.into()),
        SETTLEMENT_POT_REFUNDED => return Err(SecretGardenError::PotAlreadyRefunded.into()),
        _ => return Err(SecretGardenError::PotNotSettled.into()),
    }

    // --- first batch: freeze the terms -------------------------------------------------------
    //
    // Everything later batches depend on is decided once, here. In particular `per_entrant` is a
    // flat figure that does not come from the vault balance, so a donation arriving between
    // batches cannot change what anybody is paid.
    if ctx.accounts.settlement.state == SETTLEMENT_NONE {
        let entrant_count = ctx.accounts.round.participant_count;
        let total_pot = ctx.accounts.pot_vault.amount;

        ctx.accounts.settlement.state = SETTLEMENT_POT_REFUND_PENDING;
        ctx.accounts.settlement.entrant_count = entrant_count;
        ctx.accounts.settlement.recipient_count = 0;
        ctx.accounts.settlement.total_pot = total_pot;
        ctx.accounts.settlement.total_settled = 0;
        ctx.accounts.settlement.cursor = Pubkey::default();
        ctx.accounts.settlement.started_at = now;
        ctx.accounts.settlement.settled_at = 0;

        // What each entrant paid, and therefore what each is owed. `ENTRY_FEE_SGD` is the only
        // amount `submit_entry` ever charges and `CompetitionEntry` records no per-entry price,
        // so this is the fee, not an approximation of it.
        //
        // The `min` covers one degenerate case: a program upgrade that RAISES the fee would
        // leave older rounds holding less than the new figure per head, and paying it would
        // overdraw the vault partway through a batch. Falling back to an equal split of what is
        // actually there keeps the flat-per-head property (everyone still gets the same amount,
        // still independent of ordering) while staying solvent.
        let affordable = if entrant_count == 0 {
            0
        } else {
            total_pot
                .checked_div(entrant_count as u64)
                .ok_or(SecretGardenError::PotMathOverflow)?
        };
        let per_entrant = ENTRY_FEE_SGD.min(affordable);
        ctx.accounts.settlement.per_entrant = per_entrant;

        // Everything the entrants are not collectively owed. Donations land here, as does the
        // truncation remainder in the shortfall case. Nobody's, by construction.
        let owed = per_entrant
            .checked_mul(entrant_count as u64)
            .ok_or(SecretGardenError::PotMathOverflow)?;
        ctx.accounts.settlement.surplus = total_pot
            .checked_sub(owed)
            .ok_or(SecretGardenError::PotMathOverflow)?;

        // Nothing to hand back: a round nobody entered, or one whose vault is empty. Still
        // driven to a terminal state, because that state is also what lets `close_pot_vault`
        // reclaim the rent — leaving it pending would swap one stuck account for another.
        if entrant_count == 0 || per_entrant == 0 {
            ctx.accounts.settlement.state = SETTLEMENT_POT_REFUNDED;
            ctx.accounts.settlement.settled_at = now;
            return Ok(());
        }
    }

    // --- pay this batch ----------------------------------------------------------------------
    //
    // `[entry_1, ata_1, entry_2, ata_2, ...]`, strictly ascending by entry pubkey. The entry is
    // what proves who paid: the vault records amounts, never payers, and `CompetitionEntry` is
    // the only place the fee-payer's wallet is written down.
    let n = ctx.remaining_accounts.len();
    require!(n % 2 == 0, SecretGardenError::WrongEntryCount);
    let batch = n / 2;
    require!(batch > 0, SecretGardenError::WrongEntryCount);

    let remaining_entrants = ctx
        .accounts
        .settlement
        .entrant_count
        .checked_sub(ctx.accounts.settlement.recipient_count)
        .ok_or(SecretGardenError::PotMathOverflow)? as usize;
    require!(
        batch <= remaining_entrants,
        SecretGardenError::RefundBatchTooLong
    );

    let round_key = ctx.accounts.round.key();
    let round_id_le = round_id.to_le_bytes();
    let seeds: &[&[u8]] = &[POT_SEED, round_id_le.as_ref(), &[ctx.bumps.pot_authority]];
    let signer_seeds = &[seeds];

    let per_entrant = ctx.accounts.settlement.per_entrant;
    // The vault balance Anchor deserialized at entry; it does not move as the CPIs below run, so
    // solvency is tracked locally. Only ever decremented by the same flat amount, so this cannot
    // be steered by donations either.
    let mut vault_remaining = ctx.accounts.pot_vault.amount;

    for i in 0..batch {
        let entry_ai = &ctx.remaining_accounts[i * 2];
        let ata_ai = &ctx.remaining_accounts[i * 2 + 1];

        // Strictly ascending, which simultaneously rejects a repeat within this batch and a
        // replay of anything an earlier batch already paid.
        require!(
            entry_ai.key() > ctx.accounts.settlement.cursor,
            SecretGardenError::RefundOrderInvalid
        );

        // `Account::try_from` proves program ownership and the discriminator; the round check
        // proves it is one of THIS round's entries and not a cheaper one borrowed from another.
        let entry: Account<CompetitionEntry> = Account::try_from(entry_ai)?;
        require_keys_eq!(entry.round, round_key, SecretGardenError::EntryWrongRound);

        let ata: Account<TokenAccount> = Account::try_from(ata_ai)?;
        require_keys_eq!(
            ata.owner,
            entry.player,
            SecretGardenError::WrongWinnerAccount
        );
        require_keys_eq!(
            ata.mint,
            ctx.accounts.config.sgd_mint,
            SecretGardenError::WrongSgdMint
        );

        // Flat. No `is_final` case, no remainder, no dependence on position in the batch.
        require!(
            vault_remaining >= per_entrant,
            SecretGardenError::PotTooSmall
        );
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.pot_vault.to_account_info(),
                    mint: ctx.accounts.sgd_mint.to_account_info(),
                    to: ata_ai.clone(),
                    authority: ctx.accounts.pot_authority.to_account_info(),
                },
                signer_seeds,
            ),
            per_entrant,
            ctx.accounts.sgd_mint.decimals,
        )?;

        vault_remaining = vault_remaining
            .checked_sub(per_entrant)
            .ok_or(SecretGardenError::PotMathOverflow)?;
        ctx.accounts.settlement.total_settled = ctx
            .accounts
            .settlement
            .total_settled
            .checked_add(per_entrant)
            .ok_or(SecretGardenError::PotMathOverflow)?;
        ctx.accounts.settlement.recipient_count = ctx
            .accounts
            .settlement
            .recipient_count
            .checked_add(1)
            .ok_or(SecretGardenError::PotMathOverflow)?;
        ctx.accounts.settlement.cursor = entry_ai.key();
    }

    if ctx.accounts.settlement.recipient_count == ctx.accounts.settlement.entrant_count {
        ctx.accounts.settlement.state = SETTLEMENT_POT_REFUNDED;
        ctx.accounts.settlement.settled_at = now;
        // Everyone got the same flat amount, so this is arithmetic, not a discovery.
        require!(
            ctx.accounts.settlement.total_settled
                == per_entrant
                    .checked_mul(ctx.accounts.settlement.entrant_count as u64)
                    .ok_or(SecretGardenError::PotMathOverflow)?,
            SecretGardenError::PotMathOverflow
        );
    }

    Ok(())
}
