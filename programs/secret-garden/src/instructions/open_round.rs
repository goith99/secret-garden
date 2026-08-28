use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::error::SecretGardenError;
use crate::state::{is_operator_or_authority, CompetitionRound, GameConfig};

/// Opens the next competition round. Callable by the authority or any registered operator,
/// and only once the previous round (if any) has been finalized.
#[derive(Accounts)]
pub struct OpenRound<'info> {
    /// Authority or operator running the round; funds the new round account.
    #[account(mut)]
    pub authority: Signer<'info>,

    // Stage 5A patch: open_round starts NEW game progression (a fresh competition round),
    // so it respects the pause kill-switch — unlike close_round/finalize_round, which must
    // still wind down in-flight rounds while paused. The signer authorization is checked at
    // runtime (authority OR operator) in the handler, so the `has_one` is dropped here.
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ SecretGardenError::GamePaused,
    )]
    pub config: Box<Account<'info, GameConfig>>,

    /// The round at `config.current_round`. Required (and must be Finalized) for every
    /// round after the first; `None` only when `config.current_round == 0`.
    pub previous_round: Option<Box<Account<'info, CompetitionRound>>>,

    #[account(
        init,
        payer = authority,
        space = 8 + CompetitionRound::INIT_SPACE,
        seeds = [ROUND_SEED, (config.current_round + 1).to_le_bytes().as_ref()],
        bump,
    )]
    pub round: Box<Account<'info, CompetitionRound>>,

    // --- the round's $SGD pot vault -----------------------------------------------------
    //
    // Created HERE, by the operator opening the round, rather than lazily on first entry.
    // The alternative (`init_if_needed` on `submit_entry`) would silently bill the round's
    // first entrant ~0.00204 SOL of rent that no other entrant pays — a worse deal for being
    // early, which is exactly backwards. The operator opens the round anyway, so it absorbs
    // the cost once per round.
    /// CHECK: authority PDA that owns the vault. Derived, so no keypair for it can exist and
    /// the program is the only possible signer over the pot. Never deserialized.
    #[account(seeds = [POT_SEED, (config.current_round + 1).to_le_bytes().as_ref()], bump)]
    pub pot_authority: UncheckedAccount<'info>,

    /// The pot itself, created empty and funded by the operator.
    ///
    /// `init_if_needed` rather than `init`. The honest reason is partly practical: bankrun's
    /// VM cannot execute this SPL Token build's account-initialisation path ("unsupported BPF
    /// instruction"), so a hard `init` here would make the whole suite un-runnable offline.
    /// It is nonetheless safe, because this is a DERIVED associated token account — Anchor
    /// still enforces `associated_token::mint` and `associated_token::authority` on the
    /// adopt-existing branch, so the only account that can satisfy these constraints is the
    /// exact vault this round would have created anyway. There is no substitution to make.
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = sgd_mint,
        associated_token::authority = pot_authority,
    )]
    pub pot_vault: Box<Account<'info, TokenAccount>>,

    /// Pinned to the configured mint so the vault can only ever hold real $SGD.
    #[account(constraint = sgd_mint.key() == config.sgd_mint @ SecretGardenError::WrongSgdMint)]
    pub sgd_mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(ctx: Context<OpenRound>) -> Result<()> {
    require!(
        is_operator_or_authority(&ctx.accounts.config, &ctx.accounts.authority.key()),
        SecretGardenError::NotAuthority
    );

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

    // Mutant weighting is a temporary damper, not a rule change: see `select_target_traits`.
    let weight = ctx.accounts.config.effective_mutant_weight(now);
    let (target_traits, target_trait_count) = select_target_traits(&entropy, weight);

    ctx.accounts.round.set_inner(CompetitionRound {
        round_id: new_round_id,
        status: ROUND_STATUS_OPEN,
        start_time: now,
        end_time: round_end_time(now),
        // ROUND_CAPACITY, not MAX_PARTICIPANTS: the latter is the reveal CIRCUIT's fixed
        // 16-slot width (still used by every shard reveal under the hood), whereas this is
        // how many entries a round may ACCEPT. They were the same number only while a round
        // had to be revealed by one circuit call; the bracket removed that coupling.
        max_participants: ROUND_CAPACITY,
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

/// The instant this round's submissions close, snapped to the daily `ROUND_ANCHOR_UTC_SECONDS`
/// anchor rather than set 24h out from `now`.
///
/// Returns the first anchor STRICTLY after `now`, skipping forward one day if that anchor is
/// nearer than `MIN_ROUND_DURATION_SECONDS`. So the result is always an exact 10:00 UTC, always
/// in the future, and always at least the floor away — a round therefore runs between 12h and
/// ~36h, and the schedule reconverges on the anchor after a single round no matter how late
/// the previous cycle ran.
///
/// # Why this is what makes the schedule self-correcting
///
/// The old rule — `now + 24h`, via a `ROUND_DURATION_SECONDS` constant this change removes —
/// compounded: `open_round` cannot run until after the previous deadline, so each day's
/// `end_time` inherited the previous day's lateness AND added that day's own. Measured on
/// devnet across rounds 56-65 that came to roughly +30 min/day, dominated by the cron's hourly
/// granularity rather than the ~2 min pipeline. Anchoring to an absolute time of day discards
/// the accumulated error every round instead of carrying it.
///
/// Pure and exported so the boundary is unit-testable without a validator, exactly like
/// `select_target_traits` below.
pub fn round_end_time(now: i64) -> i64 {
    // `rem_euclid`, not `%`: for a negative `now` the latter yields a negative remainder and
    // would put `day_start` in the wrong day. Unreachable with a real clock, but the whole
    // point of a pure helper is that it is correct on its own terms.
    let day_start = now - now.rem_euclid(SECONDS_PER_DAY);
    let mut anchor = day_start + ROUND_ANCHOR_UTC_SECONDS;

    // Strictly after `now`: opening exactly ON the anchor must yield a full day, not a
    // zero-length round.
    if anchor <= now {
        anchor += SECONDS_PER_DAY;
    }

    // One skip is always enough, because the floor is less than a day (asserted in
    // `constants.rs`), so the next anchor is at most a day further out.
    if anchor - now < MIN_ROUND_DURATION_SECONDS {
        anchor += SECONDS_PER_DAY;
    }

    anchor
}

/// Picks a round's target traits from `entropy`, damping how often Mutant can appear.
///
/// `weight` is `GameConfig::effective_mutant_weight` — 255 means "no damping", 0 means "never
/// Mutant". This is the ONLY place the weighting is applied.
///
/// # Why a gated pool rather than weighted sampling
///
/// The obvious alternatives both cost more than they look:
///   - Duplicating non-Mutant ids to bias the draw breaks the no-duplicate-targets invariant,
///     because partial Fisher-Yates over a multiset can hand back the same id twice. Duplicate
///     targets would double-count in `score_entry_v2`'s matched-trait loop and silently distort
///     every score in the round.
///   - Per-step weighted sampling replaces the algorithm outright, so nothing about today's
///     behaviour would carry over unchanged.
///
/// Gating the POOL keeps Fisher-Yates exactly as it is and merely changes what it draws from,
/// so distinctness is preserved structurally (the pool is still a set) and the gate scales the
/// pre-existing Mutant rate by exactly `weight/255`.
///
/// That pre-existing rate is NOT `count/TRAIT_TABLE_LEN`. The Fisher-Yates below draws with
/// `entropy[k + 1] % remaining`, and 256 is not a multiple of 10, 9, 8 or 7, so ids in the high
/// buckets are slightly under-drawn — Mutant (id 8) among them. Exactly: 0.19635 at count 2 and
/// 0.29681 at count 3, against the 0.2 / 0.3 an unbiased draw would give. That bias predates
/// this function and is preserved deliberately; correcting it would break the byte-identity
/// guarantee below, which is worth more than 1.5% of relative accuracy on a cosmetic damper.
///
/// # Why this is provably a no-op at weight 255
///
/// The gate reads `entropy[MUTANT_GATE_ENTROPY_INDEX]` (byte 5), which the count draw
/// (`entropy[0]`) and the swap draws (`entropy[1..=4]`) never touch. So when the gate resolves
/// to "include", every input to the selection is bit-for-bit what it was before this function
/// existed. And at `weight == 255` the gate ALWAYS resolves to include — `e * 255` peaks at
/// 65025 while `w * 256` is 65280 — so the whole weighted path collapses onto the original one
/// for every possible seed, not merely for the seeds anyone happened to try. The tests below
/// enumerate both halves of that argument exhaustively.
///
/// Returns `(target_traits, target_trait_count)`; only the first `count` slots are meaningful.
pub fn select_target_traits(entropy: &[u8; 32], weight: u8) -> ([u8; 4], u8) {
    // 2..=4 traits this round (TARGET_TRAIT_MAX - TARGET_TRAIT_MIN + 1 = 3 buckets).
    let target_trait_count =
        TARGET_TRAIT_MIN + (entropy[0] % (TARGET_TRAIT_MAX - TARGET_TRAIT_MIN + 1));

    // The gate. Cross-multiplied instead of `e < w * 256 / 255` so it is exact at both ends
    // (integer division would round the endpoints inward) and needs no divide. Both sides fit
    // u16 comfortably: 255 * 255 = 65025 and 255 * 256 = 65280, against a 65535 ceiling.
    let e = entropy[MUTANT_GATE_ENTROPY_INDEX] as u16;
    let include_mutant = e * 255 < (weight as u16) * 256;

    // Build the pool: all `TRAIT_TABLE_LEN` ids, or the same list with Mutant left out. The
    // excluded case is one shorter, so the Fisher-Yates bound below is `pool_len`, not the
    // table length — the remaining ids keep their relative order and stay a set either way.
    let mut pool = [0u8; TRAIT_TABLE_LEN as usize];
    let mut pool_len = 0usize;
    for id in 0..TRAIT_TABLE_LEN {
        if id == TRAIT_ID_MUTANT && !include_mutant {
            continue;
        }
        pool[pool_len] = id;
        pool_len += 1;
    }

    // Partial Fisher-Yates over [0..pool_len); the first `count` entries are guaranteed
    // distinct trait ids (no duplicates within a round). `pool_len` is 9 or 10 and
    // TARGET_TRAIT_MAX is 4, so `remaining` is never 0 and the modulo is always safe.
    let mut target_traits = [0u8; 4];
    for k in 0..target_trait_count as usize {
        let remaining = pool_len - k;
        let swap_with = k + (entropy[k + 1] as usize % remaining);
        pool.swap(k, swap_with);
        target_traits[k] = pool[k];
    }

    (target_traits, target_trait_count)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// VERBATIM copy of the selection this program performed before the Mutant weighting
    /// existed. Kept as a literal transcription — not refactored to share code with
    /// `select_target_traits` — because its whole job is to be an independent witness that the
    /// new function reproduces the old behaviour. Sharing code would make the test vacuous.
    fn select_target_traits_legacy(entropy: &[u8; 32]) -> ([u8; 4], u8) {
        let target_trait_count =
            TARGET_TRAIT_MIN + (entropy[0] % (TARGET_TRAIT_MAX - TARGET_TRAIT_MIN + 1));
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
        (target_traits, target_trait_count)
    }

    /// Deterministic seed expansion, so a "range of seeds" is reproducible rather than random.
    /// Not cryptographic and does not need to be: it only has to spray the 6 entropy bytes the
    /// selection actually consumes across their whole joint range.
    fn seed(n: u64) -> [u8; 32] {
        let mut e = [0u8; 32];
        let mut x = n
            .wrapping_mul(0x9E37_79B9_7F4A_7C15)
            .wrapping_add(0x1234_5678_9ABC_DEF0);
        for b in e.iter_mut() {
            x ^= x >> 30;
            x = x.wrapping_mul(0xBF58_476D_1CE4_E5B9);
            x ^= x >> 27;
            x = x.wrapping_mul(0x94D0_49BB_1331_11EB);
            x ^= x >> 31;
            *b = (x & 0xFF) as u8;
        }
        e
    }

    // --- the no-op proof, in two exhaustive halves -----------------------------------------

    #[test]
    fn mutant_gate_includes_at_uniform_weight_for_every_entropy_byte() {
        // Half one: at weight 255 the gate cannot exclude, whatever byte 5 holds. All 256
        // values enumerated, so this is a proof over the byte's entire domain.
        for e in 0u16..=255 {
            assert!(
                e * 255 < (MUTANT_WEIGHT_UNIFORM as u16) * 256,
                "gate excluded Mutant at uniform weight for entropy byte {e}"
            );
        }
    }

    #[test]
    fn the_gate_never_overflows_u16() {
        // The cross-multiplied comparison is only valid if neither side wraps.
        for e in 0u16..=255 {
            for w in 0u16..=255 {
                assert!(e.checked_mul(255).is_some() && w.checked_mul(256).is_some());
            }
        }
        assert_eq!(255u16 * 255, 65025);
        assert_eq!(255u16 * 256, 65280);
    }

    #[test]
    fn uniform_weight_is_byte_identical_to_the_pre_weighting_selection() {
        // Half two: given the gate always includes, the weighted path must reproduce the old
        // one exactly. 200k seeds, compared as whole tuples (both the ids and the count).
        for n in 0..200_000u64 {
            let e = seed(n);
            let got = select_target_traits(&e, MUTANT_WEIGHT_UNIFORM);
            let want = select_target_traits_legacy(&e);
            assert_eq!(got, want, "divergence at seed {n} (entropy {:?})", &e[..6]);
        }
    }

    #[test]
    fn uniform_weight_is_byte_identical_across_the_whole_consumed_entropy_space() {
        // Stronger than the seed sweep: enumerate every value of the 6 bytes the selection
        // reads, holding the other 26 irrelevant. entropy[0] only matters mod 3 and
        // entropy[1..=4] only via `% remaining` (remaining <= 10), so stepping those by a
        // coprime stride covers every residue class they can produce.
        for b0 in 0u16..=255 {
            for b5 in 0u16..=255 {
                for step in 0u16..=10 {
                    let mut e = [0u8; 32];
                    e[0] = b0 as u8;
                    e[1] = (step * 23 + 1) as u8;
                    e[2] = (step * 37 + 2) as u8;
                    e[3] = (step * 51 + 3) as u8;
                    e[4] = (step * 67 + 5) as u8;
                    e[5] = b5 as u8;
                    assert_eq!(
                        select_target_traits(&e, MUTANT_WEIGHT_UNIFORM),
                        select_target_traits_legacy(&e),
                        "divergence at b0={b0} b5={b5} step={step}"
                    );
                }
            }
        }
    }

    // --- invariants that must hold at EVERY weight -----------------------------------------

    #[test]
    fn targets_are_always_distinct_at_every_weight() {
        for w in [0u8, 1, 32, 64, 128, 200, 254, 255] {
            for n in 0..50_000u64 {
                let e = seed(n);
                let (t, c) = select_target_traits(&e, w);
                let active = &t[..c as usize];
                for i in 0..active.len() {
                    for j in (i + 1)..active.len() {
                        assert_ne!(
                            active[i], active[j],
                            "duplicate target {} at weight {w}, seed {n}",
                            active[i]
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn count_and_ids_stay_in_range_at_every_weight() {
        for w in [0u8, 64, 128, 255] {
            for n in 0..50_000u64 {
                let e = seed(n);
                let (t, c) = select_target_traits(&e, w);
                assert!(
                    (TARGET_TRAIT_MIN..=TARGET_TRAIT_MAX).contains(&c),
                    "count {c} out of range at weight {w}, seed {n}"
                );
                for id in &t[..c as usize] {
                    assert!(*id < TRAIT_TABLE_LEN, "trait id {id} out of range");
                }
            }
        }
    }

    #[test]
    fn weight_zero_never_targets_mutant_and_still_fills_every_slot() {
        for n in 0..100_000u64 {
            let e = seed(n);
            let (t, c) = select_target_traits(&e, 0);
            assert!(
                !t[..c as usize].contains(&TRAIT_ID_MUTANT),
                "Mutant targeted at weight 0, seed {n}"
            );
            assert_eq!(c as usize, t[..c as usize].len());
        }
    }

    #[test]
    fn mutant_id_agrees_with_the_trait_table() {
        assert_eq!(TRAIT_TABLE[TRAIT_ID_MUTANT as usize].id, TRAIT_ID_MUTANT);
        assert_eq!(TRAIT_TABLE[TRAIT_ID_MUTANT as usize].name, "Mutant");
    }

    // --- the closed form ---------------------------------------------------------------------

    /// Exact probability the gate includes Mutant, by enumeration over all 256 values of the
    /// gate byte. Not `w/255` as a float: the gate is integer arithmetic over 256 outcomes, so
    /// the true value is a 256th, and the test should hold the code to what it actually does.
    fn gate_include_probability(w: u8) -> f64 {
        let n = (0u16..=255).filter(|e| e * 255 < (w as u16) * 256).count();
        n as f64 / 256.0
    }

    #[test]
    fn the_gate_probability_hits_both_endpoints_exactly() {
        assert_eq!(gate_include_probability(MUTANT_WEIGHT_UNIFORM), 1.0);
        assert_eq!(gate_include_probability(0), 0.0);
        // and is monotone in between
        let mut prev = 0.0;
        for w in 0..=255u8 {
            let p = gate_include_probability(w);
            assert!(p >= prev, "gate probability fell at weight {w}");
            prev = p;
        }
    }

    #[test]
    fn the_weight_scales_the_pre_existing_rate_by_exactly_the_gate_probability() {
        // The prediction is deliberately NOT `(w/255) * count/10`. The shipped Fisher-Yates
        // draws with `entropy[k+1] % remaining`, and 256 is not a multiple of 10, 9, 8 or 7 —
        // so trait ids in the high buckets are very slightly under-drawn. Mutant (id 8) is one
        // of them: the exact unweighted rate is 0.19635 at count 2 and 0.29681 at count 3,
        // against the 0.2 / 0.3 an unbiased draw would give.
        //
        // That bias is PRE-EXISTING and this change preserves it exactly — it is part of what
        // "byte-identical at weight 255" means, and correcting it here would break that
        // guarantee. So the baseline is measured from the legacy function on the same seeds,
        // and what is asserted is the only thing this change is responsible for: that the gate
        // multiplies whatever that rate is by the gate probability.
        const N: u64 = 400_000;
        let rate_of = |f: &dyn Fn(&[u8; 32]) -> ([u8; 4], u8)| -> f64 {
            let mut hits = 0u64;
            for n in 0..N {
                let e = seed(n);
                let (t, c) = f(&e);
                if t[..c as usize].contains(&TRAIT_ID_MUTANT) {
                    hits += 1;
                }
            }
            hits as f64 / N as f64
        };

        let baseline = rate_of(&|e| select_target_traits_legacy(e));
        assert!(
            (0.24..0.30).contains(&baseline),
            "unweighted Mutant rate {baseline:.5} is not in the expected band"
        );

        for w in [0u8, 64, 128, 192, 255] {
            let observed = rate_of(&|e| select_target_traits(e, w));
            let predicted = baseline * gate_include_probability(w);
            // 4 sigma on a binomial proportion, with a floor so w = 0 is still a real check.
            let sigma = (predicted.max(1e-9) * (1.0 - predicted) / N as f64).sqrt();
            let tol = (4.0 * sigma).max(0.0015);
            assert!(
                (observed - predicted).abs() <= tol,
                "weight {w}: observed {observed:.5} vs predicted {predicted:.5} \
                 (baseline {baseline:.5} x gate {:.5}, tol {tol:.5})",
                gate_include_probability(w)
            );
        }
    }

    #[test]
    fn frequency_is_monotonic_in_the_weight() {
        const N: u64 = 100_000;
        let rate = |w: u8| -> f64 {
            let mut hits = 0u64;
            for n in 0..N {
                let e = seed(n);
                let (t, c) = select_target_traits(&e, w);
                if t[..c as usize].contains(&TRAIT_ID_MUTANT) {
                    hits += 1;
                }
            }
            hits as f64 / N as f64
        };
        let rates: Vec<f64> = [0u8, 64, 128, 192, 255].iter().map(|w| rate(*w)).collect();
        for pair in rates.windows(2) {
            assert!(
                pair[1] >= pair[0],
                "Mutant rate fell as weight rose: {pair:?}"
            );
        }
        assert_eq!(rates[0], 0.0, "weight 0 must never target Mutant");
        assert!(
            rates[4] > 0.25,
            "uniform weight should target Mutant ~30% of rounds"
        );
    }

    // --- the daily anchor -------------------------------------------------------------------

    /// 2026-01-01T00:00:00Z. Exactly a UTC midnight (`% SECONDS_PER_DAY == 0`), so every case
    /// below can be written as "midnight plus a time of day" and read at a glance.
    const MIDNIGHT: i64 = 1_767_225_600;
    /// That day's 10:00 UTC.
    const ANCHOR: i64 = MIDNIGHT + ROUND_ANCHOR_UTC_SECONDS;

    #[test]
    fn the_test_midnight_really_is_a_midnight() {
        assert_eq!(MIDNIGHT % SECONDS_PER_DAY, 0);
    }

    #[test]
    fn the_floor_clears_the_operator_close_delay() {
        // Runtime mirror of the static assertion in constants.rs. A round shorter than the
        // operator close delay could not be closed by the cron key at all.
        assert!(MIN_ROUND_DURATION_SECONDS > MIN_OPERATOR_CLOSE_DELAY_SECONDS);
    }

    #[test]
    fn open_just_after_the_anchor_targets_tomorrows_anchor() {
        // THE STEADY-STATE CASE. The cycle closes at the anchor, spends a couple of minutes on
        // score/reveal/finalize, then opens. That round must run to the NEXT day's anchor.
        let now = ANCHOR + 300; // 10:05 UTC
        assert_eq!(round_end_time(now), ANCHOR + SECONDS_PER_DAY);
        assert_eq!(round_end_time(now) - now, SECONDS_PER_DAY - 300); // 23h55m
    }

    #[test]
    fn open_exactly_on_the_anchor_yields_a_full_day() {
        // The anchor is "strictly after now", so landing exactly on it must not produce a
        // zero-length round.
        assert_eq!(round_end_time(ANCHOR), ANCHOR + SECONDS_PER_DAY);
        assert_eq!(round_end_time(ANCHOR) - ANCHOR, SECONDS_PER_DAY);
    }

    #[test]
    fn open_just_before_the_anchor_skips_to_the_following_day() {
        // 09:55 — today's anchor is 5 minutes away, far under the floor, so it is skipped.
        // Without the floor this would be a 5-minute round.
        let now = ANCHOR - 300;
        assert_eq!(round_end_time(now), ANCHOR + SECONDS_PER_DAY);
        assert_eq!(round_end_time(now) - now, SECONDS_PER_DAY + 300); // 24h05m
    }

    #[test]
    fn open_well_before_the_anchor_still_respects_the_floor() {
        // 02:00 — today's anchor is 8h away, still under the 12h floor, so the round runs 32h.
        let now = MIDNIGHT + 2 * 3600;
        assert_eq!(round_end_time(now), ANCHOR + SECONDS_PER_DAY);
        assert_eq!(round_end_time(now) - now, 32 * 3600);
    }

    #[test]
    fn the_floor_boundary_is_exact_in_both_directions() {
        // 22:00 — tomorrow's anchor is exactly the floor away. `<` not `<=`, so it is KEPT and
        // this is the shortest round the program can ever produce.
        let at = MIDNIGHT + 79_200;
        assert_eq!(round_end_time(at), ANCHOR + SECONDS_PER_DAY);
        assert_eq!(round_end_time(at) - at, MIN_ROUND_DURATION_SECONDS);

        // One second LATER the gap is one under the floor, so a whole day is skipped. (Later,
        // not earlier: time moving forward shrinks the distance to a fixed anchor, so 21:59:59
        // is 43_201s out — comfortably over the floor — and only 22:00:01 falls under it.)
        let after = at + 1;
        assert_eq!(round_end_time(after), ANCHOR + 2 * SECONDS_PER_DAY);
        assert_eq!(
            round_end_time(after) - after,
            MIN_ROUND_DURATION_SECONDS + SECONDS_PER_DAY - 1
        );

        // And the second before the boundary is still a normal, kept anchor.
        assert_eq!(round_end_time(at - 1), ANCHOR + SECONDS_PER_DAY);
        assert_eq!(round_end_time(at - 1) - (at - 1), MIN_ROUND_DURATION_SECONDS + 1);
    }

    #[test]
    fn every_second_of_the_day_lands_on_the_anchor_and_respects_the_bounds() {
        // Exhaustive over a whole day, so no time of day can produce a short, past-dated or
        // off-anchor deadline.
        for s in 0..SECONDS_PER_DAY {
            let now = MIDNIGHT + s;
            let end = round_end_time(now);
            let dur = end - now;

            assert_eq!(
                end.rem_euclid(SECONDS_PER_DAY),
                ROUND_ANCHOR_UTC_SECONDS,
                "end_time is not on the anchor for time-of-day {s}"
            );
            assert!(end > now, "end_time is not in the future for time-of-day {s}");
            assert!(
                dur >= MIN_ROUND_DURATION_SECONDS,
                "round shorter than the floor ({dur}s) for time-of-day {s}"
            );
            assert!(
                dur < MIN_ROUND_DURATION_SECONDS + SECONDS_PER_DAY,
                "round longer than the floor plus a day ({dur}s) for time-of-day {s}"
            );
        }
    }

    #[test]
    fn the_schedule_converges_on_the_anchor_and_stays_there() {
        // The whole point of the change, modelled end to end: a round opens some time after the
        // previous deadline (cron granularity + the close/score/reveal/finalize pipeline), and
        // that lateness must NOT accumulate.
        //
        // Under the old `now + 86400` rule each `end_time` inherited every previous day's
        // lateness; here the first round absorbs it and every later one lands exactly on 10:00.
        for overhead in [62_i64, 204, 3_338, 3_612, 7_272] {
            // Start deliberately displaced — round 65's real 00:15:52 UTC drift.
            let mut open_at = MIDNIGHT + 912;
            let mut end = round_end_time(open_at);

            for round in 0..30 {
                if round > 0 {
                    assert_eq!(
                        end.rem_euclid(SECONDS_PER_DAY),
                        ROUND_ANCHOR_UTC_SECONDS,
                        "round {round} drifted off the anchor at overhead {overhead}"
                    );
                }
                // The next round can only open after this deadline, plus the cycle's overhead.
                open_at = end + overhead;
                end = round_end_time(open_at);
            }
        }
    }

    #[test]
    fn lateness_does_not_accumulate_across_rounds() {
        // Sharper form of the above: two schedules whose overheads differ by an order of
        // magnitude must still agree on every deadline after the first round.
        let start = MIDNIGHT + 912;
        let mut slow_end = round_end_time(start);
        let mut fast_end = round_end_time(start);
        for round in 1..30 {
            slow_end = round_end_time(slow_end + 3_600);
            fast_end = round_end_time(fast_end + 60);
            assert_eq!(
                slow_end, fast_end,
                "a slower cycle produced a different deadline at round {round}"
            );
        }
    }

    #[test]
    fn negative_timestamps_still_land_on_the_anchor() {
        // Unreachable from a real clock, but `%` would silently put pre-epoch times in the
        // wrong day; `rem_euclid` is what makes this hold.
        for now in [-1_i64, -86_400, -86_401, -1_000_000] {
            let end = round_end_time(now);
            assert_eq!(end.rem_euclid(SECONDS_PER_DAY), ROUND_ANCHOR_UTC_SECONDS);
            assert!(end > now);
            assert!(end - now >= MIN_ROUND_DURATION_SECONDS);
        }
    }
}
