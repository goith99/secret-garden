use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::{CompetitionRound, GameConfig};

/// Opens the next competition round. Only the configured authority may call this, and
/// only once the previous round (if any) has been finalized.
#[derive(Accounts)]
pub struct OpenRound<'info> {
    /// Configured game authority; funds the new round account.
    #[account(mut)]
    pub authority: Signer<'info>,

    // Stage 5A patch: open_round starts NEW game progression (a fresh competition round),
    // so it respects the pause kill-switch — unlike close_round/finalize_round, which must
    // still wind down in-flight rounds while paused. `config` already exists here (read for
    // `current_round`), so this only adds the constraint; open_round's logic is unchanged.
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ SecretGardenError::NotAuthority,
        constraint = !config.paused @ SecretGardenError::GamePaused,
    )]
    pub config: Account<'info, GameConfig>,

    /// The round at `config.current_round`. Required (and must be Finalized) for every
    /// round after the first; `None` only when `config.current_round == 0`.
    pub previous_round: Option<Account<'info, CompetitionRound>>,

    #[account(
        init,
        payer = authority,
        space = 8 + CompetitionRound::INIT_SPACE,
        seeds = [ROUND_SEED, (config.current_round + 1).to_le_bytes().as_ref()],
        bump,
    )]
    pub round: Account<'info, CompetitionRound>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(ctx: Context<OpenRound>) -> Result<()> {
    let current = ctx.accounts.config.current_round;

    if current > 0 {
        let previous = ctx
            .accounts
            .previous_round
            .as_ref()
            .ok_or(SecretGardenError::PreviousRoundNotFinalized)?;
        // A round's `round_id` is fixed to its PDA seed at creation and never changes,
        // so matching the id proves this is the unique round at `current`.
        require!(
            previous.round_id == current,
            SecretGardenError::PreviousRoundNotFinalized
        );
        require!(
            previous.status == ROUND_STATUS_FINALIZED,
            SecretGardenError::PreviousRoundNotFinalized
        );
    }

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let new_round_id = current + 1;

    // Public pseudo-random target-trait selection. Entropy = SHA-256(slot || timestamp ||
    // round_id). LIMITATION: these inputs are weakly predictable (the operator/validator
    // can influence the slot), but the target traits are INTENTIONALLY public — players
    // strategize around them — so unpredictability is not a security requirement here.
    let entropy = solana_sha256_hasher::hashv(&[
        &clock.slot.to_le_bytes(),
        &now.to_le_bytes(),
        &new_round_id.to_le_bytes(),
    ])
    .to_bytes();

    // 2..=4 traits this round (TARGET_TRAIT_MAX - TARGET_TRAIT_MIN + 1 = 3 buckets).
    let target_trait_count =
        TARGET_TRAIT_MIN + (entropy[0] % (TARGET_TRAIT_MAX - TARGET_TRAIT_MIN + 1));

    // Partial Fisher-Yates over [0..TRAIT_TABLE_LEN); the first `count` entries are
    // guaranteed distinct trait ids (no duplicates within a round).
    let mut pool = [0u8; TRAIT_TABLE_LEN as usize];
    for (k, slot) in pool.iter_mut().enumerate() {
        *slot = k as u8;
    }
    let mut target_traits = [0u8; 4];
    for k in 0..target_trait_count as usize {
        let remaining = TRAIT_TABLE_LEN as usize - k;
        let swap_with = k + (entropy[k + 1] as usize % remaining);
        pool.swap(k, swap_with);
        target_traits[k] = pool[k];
    }

    ctx.accounts.round.set_inner(CompetitionRound {
        round_id: new_round_id,
        status: ROUND_STATUS_OPEN,
        start_time: now,
        end_time: now + ROUND_DURATION_SECONDS,
        max_participants: MAX_PARTICIPANTS,
        participant_count: 0,
        authority: ctx.accounts.authority.key(),
        bump: ctx.bumps.round,
        target_traits,
        target_trait_count,
        top1: Pubkey::default(),
        top2: Pubkey::default(),
        top3: Pubkey::default(),
        scoring_revealed: false,
        scored_count: 0,
    });

    ctx.accounts.config.current_round = new_round_id;
    Ok(())
}
