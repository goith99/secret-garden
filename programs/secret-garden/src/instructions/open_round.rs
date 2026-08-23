use anchor_lang::prelude::*;

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
        end_time: now + ROUND_DURATION_SECONDS,
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
}
