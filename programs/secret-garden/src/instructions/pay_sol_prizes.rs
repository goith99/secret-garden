use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::{
    is_operator_or_authority, CompetitionEntry, CompetitionRound, GameConfig, PrizeDistribution,
};

/// Pays a finalized, revealed round's SOL prizes, and records on-chain that it did.
///
/// # Why this instruction exists at all
///
/// The SOL prizes were already being paid — correctly, mostly — by an off-chain treasury
/// keypair sending a bare `SystemProgram::transfer` to each winner. The payment was never the
/// problem. The problem was that a system transfer writes NOTHING into this program's account
/// graph, so afterwards nothing anywhere could answer "was round N paid?". Two separate tools
/// had to guess, and they guessed differently:
///
///   * `auto-cycle.ts` treated it as process-local control flow — prizes are paid if and only
///     if THIS invocation had just performed the reveal itself. Every manual reveal, every
///     crashed run, every resumed run therefore fell through to "not paid by me", and nothing
///     else ever picked it up. That is not a theoretical gap; it is how rounds 63, 65 and 67
///     came to owe their winners, and the operator's only signal was a line in a cron log.
///
///   * `operator.ts` tried to recover the fact after the event by intersecting the winner's and
///     the treasury's transaction histories. That window has no upper bound, so a winner who
///     also won a LATER round reads as proof the earlier round was settled — and the match is
///     on any shared transaction at all, not on a transfer of the right size in the right
///     direction. It can say "already paid" when nothing was paid, and "unpaid" when the
///     payout is simply past its pagination limit.
///
/// Both guards are attempts to reconstruct a fact that was never written down. This instruction
/// writes it down. `init` on `PrizeDistribution` is the same primitive `distribute_pot` already
/// relies on for the $SGD pot: a second call cannot land, because the account is already there.
///
/// # Atomicity
///
/// The marker is created in the same instruction as the transfers, so there is no window in
/// which one happened and the other did not. A failure anywhere reverts both — the payout and
/// the receipt are one event, which is exactly the property the off-chain version could not
/// have no matter how carefully it was sequenced.
///
/// # Why the amounts are an argument
///
/// Because they genuinely vary. `auto-cycle.ts` scales the base prize by a rarity multiplier of
/// up to 1.75x, so there is no single correct lamport figure this instruction could enforce
/// without changing what winners are paid — and repricing the game is not what a fund-safety
/// fix should do on its way past. What it enforces instead is a ceiling
/// (`SOL_PRIZE_MAX_LAMPORTS`): the caller picks the amount, the chain refuses anything no
/// legitimate policy could produce. That keeps the marker honest about what was actually sent
/// while leaving the payout policy where it already lives.
///
/// # Why the treasury is a plain signer
///
/// It stays an ordinary wallet rather than becoming a program-owned vault. Making it a PDA
/// would mean migrating the existing treasury balance and giving the program unilateral spend
/// authority over the prize pool, which is a larger change and a worse trust story than the
/// one problem being fixed here. As a signer it can only ever pay when its holder chooses to,
/// and the authority/operator gate below still decides which rounds are payable.
#[derive(Accounts)]
pub struct PaySolPrizes<'info> {
    /// Authority or operator. Pays the marker's rent. Operators are allowed because, unlike a
    /// refund, this pays out a result the chain has already agreed on — the reveal decided the
    /// winners and this instruction has no discretion about who they are.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The wallet the prizes come out of. Must sign, so nobody can spend a treasury they do not
    /// hold, and `mut` because it is debited.
    #[account(mut)]
    pub treasury: Signer<'info>,

    /// Not pause-gated, matching `distribute_pot`: paying out a round that is already over must
    /// keep working while the game is paused.
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GameConfig>,

    /// Seed-checked against its own stored id, so the caller cannot pay round X's winners while
    /// consuming round Y's marker.
    #[account(
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
    )]
    pub round: Account<'info, CompetitionRound>,

    /// THE REPLAY GUARD, and the whole point of the change. `init` fails if it already exists,
    /// so a second payout for the same round cannot land — no matter which tool tries it, how
    /// long afterwards, or what its own bookkeeping believes.
    #[account(
        init,
        payer = authority,
        space = 8 + PrizeDistribution::INIT_SPACE,
        seeds = [PRIZE_DIST_SEED, round.round_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub prize_distribution: Account<'info, PrizeDistribution>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler<'info>(
    ctx: Context<'info, PaySolPrizes<'info>>,
    amounts: Vec<u64>,
) -> Result<()> {
    require!(
        is_operator_or_authority(&ctx.accounts.config, &ctx.accounts.authority.key()),
        SecretGardenError::NotAuthority
    );

    let round = &ctx.accounts.round;
    require!(
        round.status == ROUND_STATUS_FINALIZED,
        SecretGardenError::RoundNotFinalized
    );
    // Without this, `top1/2/3` may still be all-default and the prizes would be paid to nobody
    // while the marker recorded the round as settled forever.
    require!(round.scoring_revealed, SecretGardenError::RoundNotRevealed);

    // However many winners the reveal actually named. A 1- or 2-entry round pays that many
    // prizes rather than sending a third of the pool to `Pubkey::default()`.
    let winners: Vec<Pubkey> = [round.top1, round.top2, round.top3]
        .into_iter()
        .filter(|w| *w != Pubkey::default())
        .collect();
    let k = winners.len();

    let now = Clock::get()?.unix_timestamp;

    // A revealed round with no entries at all. The marker is still written, so the round is
    // closed out and no later run has to re-derive whether anything was owed.
    if k == 0 {
        ctx.accounts.prize_distribution.set_inner(PrizeDistribution {
            round_id: round.round_id,
            total_paid: 0,
            largest_paid: 0,
            treasury: ctx.accounts.treasury.key(),
            winner_count: 0,
            paid_at: now,
            bump: ctx.bumps.prize_distribution,
        });
        return Ok(());
    }

    // One amount per winner, each individually bounded. A zero would record a winner as paid
    // while sending them nothing, which is exactly the kind of silent non-payment this whole
    // change exists to make impossible.
    require!(amounts.len() == k, SecretGardenError::WrongEntryCount);
    let mut total: u64 = 0;
    for a in &amounts {
        require!(*a > 0, SecretGardenError::PotTooSmall);
        require!(
            *a <= SOL_PRIZE_MAX_LAMPORTS,
            SecretGardenError::PrizeAmountTooLarge
        );
        total = total.checked_add(*a).ok_or(SecretGardenError::PotMathOverflow)?;
    }
    // Checked up front so an underfunded treasury produces a named error rather than a bare
    // system-program failure partway through, after some winners have already been paid.
    require!(
        ctx.accounts.treasury.lamports() >= total,
        SecretGardenError::TreasuryUnderfunded
    );

    // `[entry_1, wallet_1, entry_2, wallet_2, ...]` in rank order. Passing the entries is what
    // proves a destination belongs to the wallet that actually placed the winning entry:
    // `top1/2/3` are ENTRY pubkeys, not wallets, so the payee is only discoverable by reading
    // `entry.player`. This mirrors `distribute_pot` exactly — the $SGD and SOL payouts should
    // not have two different ideas of who won.
    require!(
        ctx.remaining_accounts.len() == k * 2,
        SecretGardenError::WrongEntryCount
    );

    let mut total_paid: u64 = 0;
    for i in 0..k {
        let entry_ai = &ctx.remaining_accounts[i * 2];
        let wallet_ai = &ctx.remaining_accounts[i * 2 + 1];

        // The entry must be exactly the one the reveal named for this rank.
        require_keys_eq!(entry_ai.key(), winners[i], SecretGardenError::EntryMismatch);
        let entry: Account<CompetitionEntry> = Account::try_from(entry_ai)?;
        require_keys_eq!(
            wallet_ai.key(),
            entry.player,
            SecretGardenError::WrongWinnerAccount
        );

        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.treasury.to_account_info(),
                    to: wallet_ai.clone(),
                },
            ),
            amounts[i],
        )?;

        total_paid = total_paid
            .checked_add(amounts[i])
            .ok_or(SecretGardenError::PotMathOverflow)?;
    }

    require!(total_paid == total, SecretGardenError::PotMathOverflow);

    ctx.accounts.prize_distribution.set_inner(PrizeDistribution {
        round_id: round.round_id,
        total_paid,
        largest_paid: amounts.iter().copied().max().unwrap_or(0),
        treasury: ctx.accounts.treasury.key(),
        winner_count: k as u8,
        paid_at: now,
        bump: ctx.bumps.prize_distribution,
    });
    Ok(())
}
