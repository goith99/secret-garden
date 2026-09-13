use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::{CompetitionEntry, CompetitionRound, FlowerRecord, GameConfig};

/// Returns a flower that competed in a now-Finalized round to the player's collection
/// (Submitted -> Active), making it usable again: breedable, closeable, re-submittable.
///
/// `submit_entry` flips the flower to `FLOWER_STATUS_SUBMITTED` and leaves it there
/// forever; before this instruction existed, a submitted flower was permanently dead
/// weight — it could not be bred with, deleted, or entered into a later round, and it
/// still occupied a collection slot (`submit_entry` never decrements `total_flowers`).
///
/// # PERMISSIONLESS, and re-keyed off the entry
///
/// This used to require the flower's owner to sign, and derived the entry from that
/// signer: `seeds = [ENTRY_SEED, round, owner]` plus `flower.owner == owner`. Both are
/// gone, and they had to go together, because together they were a latent bug.
///
/// Once a flower can change hands — which is what the NFT layer introduces — those two
/// constraints become unsatisfiable by anybody at the same time. Transfer a Submitted
/// flower and the new owner has no entry PDA (they never submitted), while the original
/// submitter no longer matches `flower.owner`. The flower stays Submitted forever, which
/// also means it can never breed again. Nobody can rescue it: not the seller, not the
/// buyer, not the authority.
///
/// So the question this instruction asks changed. It no longer asks WHO is calling — it
/// asks whether the chain has already earned the transition, and the round being
/// Finalized is that proof. Anyone may then finalize it. There is nothing to gate: the
/// only reachable effect is returning a flower to its own owner's control, which is
/// exactly what should happen, and `entry.status` still makes it one-shot.
///
/// This is deliberately the SAME shape as the post-breed thaw crank: a permissionless
/// instruction that completes a state transition the chain has already committed to.
/// Sharing the pattern means one authorization story for this whole category rather than
/// a bespoke rule per instruction — see the design note in `docs/`, section B.
///
/// # What proves the caller passed the right accounts
///
/// Every check is still an account constraint; none of them needs a signature:
///   - `!config.paused` — a player-facing action;
///   - `round.status == ROUND_STATUS_FINALIZED` — the round must be completely done.
///     This is the gate that matters: while a round is Open/Closed its entries can still
///     be scored and revealed, and the reveal path reads the entry accounts, so pulling a
///     flower back to Active mid-round would let it be bred (mutating it) or submitted
///     elsewhere while it is still competing;
///   - the `entry` PDA is proven by SELF-REFERENTIAL seeds — `[ENTRY_SEED, round,
///     entry.player]` — the same idiom `queue_private_hint` uses for its round. The seeds
///     no longer mention the caller, so they no longer assume the caller is the submitter,
///     but they still prove this is a genuine entry PDA belonging to the player it names;
///   - `entry.round == round` and `entry.flower_record == flower` pin the entry to this
///     round and this exact flower. That pair is unique: `submit_entry` requires the
///     flower to be Active and immediately marks it Submitted, so a flower can be entered
///     at most once per round, and at most one entry can therefore satisfy both;
///   - `entry.status == ENTRY_STATUS_SUBMITTED` makes release ONE-SHOT per entry, which is
///     what stops an old finalized entry from being replayed against a later live round;
///   - `flower.status == FLOWER_STATUS_SUBMITTED`, `flower.genome_status ==
///     GENOME_STATUS_ENCRYPTED` — hybrids only, mirroring `close_flower`.
///
/// KNOWN LIMITATION, unchanged by this rework: a STARTER submitted to a round is still
/// stuck Submitted forever — release refuses it (`StarterNotDeletable`), so it stays
/// unbreedable and unsubmittable. Unlike `close_flower`, release does not touch
/// `total_flowers`, so the accounting invariant that justifies the hybrid-only rule there
/// does not actually apply here; the restriction is carried over deliberately and can be
/// dropped later if starters should be releasable too.
///
/// ACCOUNTING: `total_flowers` is deliberately NOT touched. `submit_entry` never
/// decremented it, so the flower has occupied its collection slot continuously; the
/// `total_flowers - STARTER_COUNT == live hybrid count` invariant holds only if release
/// leaves the counter alone. (Deleting the flower afterwards via `close_flower` is what
/// decrements it, exactly once.)
///
/// The ownership-sync counter adjustment that this instruction will eventually carry is
/// NOT here yet, and cannot be: it reads the flower's mint and token account to find the
/// real holder, and no mint exists until `mint_flower_nft` ships. Until then
/// `flower.owner` cannot diverge from reality, so the sync would be unreachable code.
#[derive(Accounts)]
pub struct ReleaseFlower<'info> {
    /// No signer. See the header: this instruction is permissionless, and the transaction's
    /// fee payer is whoever submits it. Nothing here is created or funded, so no `payer` is
    /// needed in the account list either.
    ///
    /// Pause kill-switch: releasing is a player-facing action, blocked while paused.
    ///
    /// BOXED, and not cosmetically. `ReleaseFlower::try_accounts` sat 8 bytes over SBF's
    /// 4,096-byte frame limit as a build WARNING for a long time; appending
    /// `pending_authority` to `GameConfig` turned that warning into a runtime "Program failed
    /// to complete" on every release. Boxing the three big deserialized bodies moves them to
    /// the heap and brings the frame back well under. Same fix, and same reason, as the
    /// comment in `SubmitEntry`.
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ SecretGardenError::GamePaused,
    )]
    pub config: Box<Account<'info, GameConfig>>,

    /// The round the flower competed in. Must be fully Finalized — see the gate note above.
    #[account(
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
        constraint = round.status == ROUND_STATUS_FINALIZED
            @ SecretGardenError::RoundNotFinalized,
    )]
    pub round: Box<Account<'info, CompetitionRound>>,

    /// The caller's entry in that round. KEPT (never closed) — it is the round's permanent
    /// record, and `round.top1/2/3` name entry pubkeys — but its `status` is flipped to
    /// `ENTRY_STATUS_RELEASED` so each entry can release its flower exactly ONCE. See
    /// `ENTRY_STATUS_RELEASED` for the replay this closes.
    #[account(
        mut,
        seeds = [ENTRY_SEED, round.key().as_ref(), entry.player.as_ref()],
        bump = entry.bump,
        constraint = entry.round == round.key() @ SecretGardenError::EntryMismatch,
        constraint = entry.flower_record == flower.key() @ SecretGardenError::EntryMismatch,
        constraint = entry.status == ENTRY_STATUS_SUBMITTED
            @ SecretGardenError::EntryAlreadyReleased,
    )]
    pub entry: Box<Account<'info, CompetitionEntry>>,

    /// The flower to release. No `seeds` needed: Anchor proves it is a program-owned
    /// `FlowerRecord`, and the `entry.flower_record` constraint above pins it to this
    /// specific entry — which is the whole of the proof now that no owner signs.
    #[account(
        mut,
        constraint = flower.status == FLOWER_STATUS_SUBMITTED
            @ SecretGardenError::FlowerNotSubmitted,
        constraint = flower.genome_status == GENOME_STATUS_ENCRYPTED
            @ SecretGardenError::StarterNotDeletable,
    )]
    pub flower: Box<Account<'info, FlowerRecord>>,

    // --- ownership sync (design doc §B) -------------------------------------------------
    /// CHECK: seeds-pinned, so a caller cannot hide that this flower has an NFT.
    #[account(seeds = [MINT_SEED, flower.key().as_ref()], bump)]
    pub flower_mint: UncheckedAccount<'info>,
    /// CHECK: verified in `sync_flower_owner` (mint match + amount == 1).
    pub flower_token: UncheckedAccount<'info>,
    /// CHECK: PDA-checked in the helper against the PRE-sync `flower.owner`.
    #[account(mut)]
    pub previous_profile: UncheckedAccount<'info>,
    /// CHECK: PDA-checked in the helper against the real holder.
    ///
    /// The no-profile refusal inside the helper is UNREACHABLE from here, and deliberately
    /// left in rather than special-cased: this instruction only ever runs on a frozen
    /// token, and a frozen token cannot be transferred, so the holder is necessarily
    /// whoever placed the lock — someone who had a profile to do so. If the freeze
    /// mechanism ever changes such that a flower can reach here unfrozen, the guard is
    /// already there and will start firing instead of silently miscounting.
    #[account(mut)]
    pub new_profile: UncheckedAccount<'info>,
}

pub(crate) fn handler(ctx: Context<ReleaseFlower>) -> Result<()> {
    // Reconcile the record against the chain before releasing it, so the flower comes back
    // Active belonging to whoever actually holds it — not to whoever last competed with it.
    crate::sync::sync_flower_owner(
        &mut ctx.accounts.flower,
        &ctx.accounts.flower_mint,
        &ctx.accounts.flower_token,
        &ctx.accounts.previous_profile,
        &ctx.accounts.new_profile,
    )?;
    ctx.accounts.flower.status = FLOWER_STATUS_ACTIVE;
    // Burn the entry's release right, so this finalized entry can never be replayed to pull
    // the same flower out of a LATER, still-live round.
    ctx.accounts.entry.status = ENTRY_STATUS_RELEASED;
    Ok(())
}
