use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::{GameConfig, MintGate};

/// Opens or closes `mint_flower_nft`, and nothing else.
///
/// OPERATOR-LEVEL, deliberately. `set_paused` is authority-only because it halts the whole
/// game; this halts one instruction, and the whole point of it is to be flippable during a
/// post-deploy observation window without arranging a multisig signature. `is_operator_or_
/// authority` is the same gate the round instructions and `operator_migrate_flower` use.
///
/// NOT a substitute for `set_paused`, and not overlapping with it. Pausing the game blocks
/// mint, burn, close_flower, breeding and submitting together; this blocks new mints while
/// leaving every existing NFT fully usable — which is exactly what an observation period
/// wants, and what pausing cannot express.
///
/// `init_if_needed` so the first call creates the gate and later calls flip it. Creating it
/// already-enabled is possible but pointless: the interesting default is closed, and that is
/// what the absence of the account already means.
#[derive(Accounts)]
pub struct SetMintingEnabled<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GameConfig>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + MintGate::INIT_SPACE,
        seeds = [MINT_GATE_SEED],
        bump,
    )]
    pub gate: Account<'info, MintGate>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(ctx: Context<SetMintingEnabled>, enabled: bool) -> Result<()> {
    require!(
        crate::is_operator_or_authority(&ctx.accounts.config, &ctx.accounts.authority.key()),
        SecretGardenError::NotAuthority
    );
    let gate = &mut ctx.accounts.gate;
    gate.enabled = enabled;
    gate.updated_at = Clock::get()?.unix_timestamp;
    gate.bump = ctx.bumps.gate;
    Ok(())
}
