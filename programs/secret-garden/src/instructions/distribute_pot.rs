use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::{
    is_operator_or_authority, CompetitionEntry, CompetitionRound, GameConfig, PotDistribution,
};

/// Pays a finalized round's $SGD pot out, split equally between its revealed winners.
///
/// # Why this is not part of `finalize_round`
///
/// `finalize_round` checks only `status == CLOSED` — it never looks at `scoring_revealed`, and a
/// round can legitimately be finalized without ever being scored or revealed. Paying there would
/// send the pot to `Pubkey::default()` on any such round. It is also deliberately not
/// pause-gated, because winding down in-flight state must work while paused. So the payout gets
/// its own instruction with its own, stricter gate.
///
/// This instruction is likewise NOT pause-gated: like `close_round`/`finalize_round` it winds
/// down a round that is already over, and stranding players' fees behind a pause would be worse
/// than letting the payout land.
#[derive(Accounts)]
pub struct DistributePot<'info> {
    /// Authority or operator. Pays the marker's rent (and any winner ATA it has to create).
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GameConfig>,

    /// The round being paid out. Seed-checked against its own stored id, so a caller cannot
    /// pass round X's account while deriving the vault and marker for round Y.
    #[account(
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
    )]
    pub round: Account<'info, CompetitionRound>,

    /// THE REPLAY GUARD. `init` fails if this already exists, so a second `distribute_pot` for
    /// the same round cannot land. A vault-balance check would NOT be sufficient: anyone can
    /// transfer $SGD into a distributed vault and re-arm the payout.
    #[account(
        init,
        payer = authority,
        space = 8 + PotDistribution::INIT_SPACE,
        seeds = [POT_DIST_SEED, round.round_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub pot_distribution: Account<'info, PotDistribution>,

    /// CHECK: the pot vault's authority. Derived here from the round id, so it is a PDA and
    /// nothing else — no keypair for it exists, and the program signing with these seeds is the
    /// only way the vault can ever move. Not deserialized; only its key and bump are used.
    #[account(seeds = [POT_SEED, round.round_id.to_le_bytes().as_ref()], bump)]
    pub pot_authority: UncheckedAccount<'info>,

    /// The round's pot. Both its mint and its owner are constrained, so a caller cannot
    /// substitute a vault they control or one holding a different token.
    #[account(
        mut,
        constraint = pot_vault.mint == config.sgd_mint @ SecretGardenError::WrongSgdMint,
        constraint = pot_vault.owner == pot_authority.key() @ SecretGardenError::WrongSgdMint,
    )]
    pub pot_vault: Account<'info, TokenAccount>,

    /// Pinned to `config.sgd_mint`, so the payout cannot be redirected at an attacker's mint.
    #[account(constraint = sgd_mint.key() == config.sgd_mint @ SecretGardenError::WrongSgdMint)]
    pub sgd_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn handler<'info>(
    ctx: Context<'info, DistributePot<'info>>,
) -> Result<()> {
    require!(
        is_operator_or_authority(&ctx.accounts.config, &ctx.accounts.authority.key()),
        SecretGardenError::NotAuthority
    );
    require_keys_neq!(
        ctx.accounts.config.sgd_mint,
        Pubkey::default(),
        SecretGardenError::SgdMintNotSet
    );

    let round = &ctx.accounts.round;
    require!(
        round.status == ROUND_STATUS_FINALIZED,
        SecretGardenError::RoundNotFinalized
    );
    // Without this, `top1/2/3` may still be all-default and the pot would be paid to nobody.
    require!(
        round.scoring_revealed,
        SecretGardenError::RoundNotRevealed
    );

    // However many winners the reveal actually wrote. `reveal` fills these in rank order and
    // only up to `participant_count`, so a 1- or 2-entry round yields k = 1 or 2 and the pot is
    // split that many ways rather than a third of it being stranded.
    let winners: Vec<Pubkey> = [round.top1, round.top2, round.top3]
        .into_iter()
        .filter(|w| *w != Pubkey::default())
        .collect();
    let k = winners.len();

    // Balance-as-truth: whatever the vault actually holds is the pot. Nothing is stored and
    // compared, so a vault that received more (a sponsor) or less than expected still pays out
    // exactly what is there, and the transfers can never exceed the balance.
    let pot = ctx.accounts.pot_vault.amount;

    // k == 0 means a revealed round with no entries at all. Nothing to pay; leave the vault
    // untouched. The marker is still written, so this round is closed out either way.
    if k == 0 || pot == 0 {
        let now = Clock::get()?.unix_timestamp;
        ctx.accounts.pot_distribution.set_inner(PotDistribution {
            round_id: round.round_id,
            total_paid: 0,
            winner_count: 0,
            distributed_at: now,
            bump: ctx.bumps.pot_distribution,
        });
        return Ok(());
    }

    // An equal split has to give everyone at least one base unit, or somebody is "paid" zero.
    require!(pot >= k as u64, SecretGardenError::PotTooSmall);

    // Remainder-safe equal split: the first k-1 winners get `share`, the last takes whatever is
    // left. Integer division truncates by at most k-1 base units, and folding that into the
    // final transfer means the vault drains to exactly zero — no dust stranded behind a PDA no
    // one can sign for, and no possibility of the transfers summing to more than the balance.
    let share = pot.checked_div(k as u64).ok_or(SecretGardenError::PotMathOverflow)?;
    let paid_before_last = share
        .checked_mul((k - 1) as u64)
        .ok_or(SecretGardenError::PotMathOverflow)?;
    let last = pot
        .checked_sub(paid_before_last)
        .ok_or(SecretGardenError::PotMathOverflow)?;

    // The winner ATAs come in as remaining_accounts, in the same rank order as `winners`, each
    // paired with its CompetitionEntry: [entry_1, ata_1, entry_2, ata_2, ...]. Passing the
    // entries is what proves an ATA belongs to the wallet that actually placed the winning
    // entry — `top1/2/3` are ENTRY pubkeys, not wallets, so the payer is only discoverable by
    // reading `entry.player`.
    require!(
        ctx.remaining_accounts.len() == k * 2,
        SecretGardenError::WrongEntryCount
    );

    let round_id_le = round.round_id.to_le_bytes();
    let seeds: &[&[u8]] = &[POT_SEED, round_id_le.as_ref(), &[ctx.bumps.pot_authority]];
    let signer_seeds = &[seeds];

    let mut total_paid: u64 = 0;
    for i in 0..k {
        let entry_ai = &ctx.remaining_accounts[i * 2];
        let ata_ai = &ctx.remaining_accounts[i * 2 + 1];

        // The entry must be exactly the one the reveal named for this rank. Anything else and
        // the payout could be pointed at a wallet that never won.
        require_keys_eq!(entry_ai.key(), winners[i], SecretGardenError::EntryMismatch);
        let entry: Account<CompetitionEntry> = Account::try_from(entry_ai)?;

        // And the destination must be a $SGD account owned by that entry's player.
        let ata: Account<TokenAccount> = Account::try_from(ata_ai)?;
        require_keys_eq!(ata.owner, entry.player, SecretGardenError::WrongSgdMint);
        require_keys_eq!(ata.mint, ctx.accounts.config.sgd_mint, SecretGardenError::WrongSgdMint);

        let amount = if i == k - 1 { last } else { share };
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
            amount,
            ctx.accounts.sgd_mint.decimals,
        )?;
        total_paid = total_paid
            .checked_add(amount)
            .ok_or(SecretGardenError::PotMathOverflow)?;
    }

    // The split is exact by construction; assert it rather than trust it.
    require!(total_paid == pot, SecretGardenError::PotMathOverflow);

    let now = Clock::get()?.unix_timestamp;
    ctx.accounts.pot_distribution.set_inner(PotDistribution {
        round_id: round.round_id,
        total_paid,
        winner_count: k as u8,
        distributed_at: now,
        bump: ctx.bumps.pot_distribution,
    });
    Ok(())
}
