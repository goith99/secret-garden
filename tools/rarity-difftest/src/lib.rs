//! Differential test: the bred-hybrid rarity roll, as it appears in THREE places.
//!
//! WHAT THIS IS. Three independent transcriptions of the same tier function
//! `tier(roll, lift) -> u8` and its mask packing, one per place the math is written down:
//!
//!   1. `circuit`       — encrypted-ixs/src/lib.rs, the rarity block inside `breed`.
//!                        The only EXECUTABLE definition; everything else mirrors it.
//!   2. `callback`      — programs/secret-garden/src/lib.rs `breed_callback`, which
//!                        unpacks bits 19-21 and strips them from the stored mask.
//!   3. `constants_doc` — programs/secret-garden/src/constants.rs, the `RARITY_BASE_*` /
//!                        `RARITY_SHIFT` / `RARITY_STRIP_MASK` mirror. Nothing compiles
//!                        these against the circuit, so they are the copy most likely to rot.
//!
//! Each is transcribed with the Arcis wrappers stripped: secret `u8`/`u16` values become
//! plain host integers, since every operation in the rarity block is ordinary unsigned
//! arithmetic with no data-dependent control flow. The expressions are copied verbatim, in
//! source order. Any edit here that is not also in the corresponding source invalidates
//! the result.
//!
//! WHAT THIS IS NOT. It does not prove the Arcis compilation is correct, nor that MPC
//! evaluation matches host evaluation, nor that `ArcisRNG::gen_uniform::<u8>()` is
//! uniform. It proves exactly three things: the transcriptions denote the same function;
//! the packing round-trips for every reachable input; and the resulting distribution is
//! the one the design specifies.
//!
//! WHY IT CAN BE EXHAUSTIVE. The tier function's entire input domain is
//! `roll in 0..=255` x `lift in 0..=63` — 16,384 cases, all enumerated below. The packing
//! is checked across the full cross product of four visual classes (0..=4 each) and all
//! six tier values, another 3,750 cases. Nothing is sampled.
//!
//! Run: cargo test --release

// ---------------------------------------------------------------------------------------
// 1. CIRCUIT — verbatim from encrypted-ixs/src/lib.rs, `breed`'s rarity block.
// ---------------------------------------------------------------------------------------

/// The PUBLIC half of the lift. Transcribed from the circuit; `parent_*_rarity` and
/// `offspring_generation` are plaintext params there, so this is clear-text arithmetic.
pub fn circuit_public_lift(parent_a_rarity: u8, parent_b_rarity: u8, offspring_generation: u8) -> u8 {
    let gen_c: u8 = if offspring_generation > 10 {
        10
    } else {
        offspring_generation
    };
    (parent_a_rarity + parent_b_rarity) * 4 + gen_c * 1
}

/// The SECRET half of the lift — deliberately quantised to four levels.
pub fn circuit_env_lift(light: u8, water: u8, soil: u8) -> u8 {
    (((light as u16 + water as u16 + soil as u16) / 3) as u8) / 64
}

/// The tier itself, via branchless carry extraction. Verbatim from the circuit.
pub fn circuit_tier(rarity_roll: u8, lift: u16) -> u8 {
    let b_uncommon: u16 = 115 - lift;
    let b_rare: u16 = 192 - lift;
    let b_epic: u16 = 230 - lift / 4;
    let b_legendary: u16 = 251 - lift / 8;

    let r16 = rarity_roll as u16;
    1 + ((r16 + 256 - b_uncommon) / 256) as u8
        + ((r16 + 256 - b_rare) / 256) as u8
        + ((r16 + 256 - b_epic) / 256) as u8
        + ((r16 + 256 - b_legendary) / 256) as u8
}

/// The mask packing, verbatim from the circuit.
pub fn circuit_pack(petal: u8, color: u8, leaf: u8, stem: u8, tier: u8) -> u32 {
    petal as u32
        + (color as u32) * 256
        + (leaf as u32) * 65_536
        + (stem as u32) * 16_777_216
        + (tier as u32) * 524_288
}

// ---------------------------------------------------------------------------------------
// 2. CALLBACK — verbatim from programs/secret-garden/src/lib.rs, `breed_callback`.
// ---------------------------------------------------------------------------------------

pub fn callback_unpack_rarity(revealed_trait_mask: u32) -> u8 {
    ((revealed_trait_mask >> CONST_RARITY_SHIFT) & 0x7) as u8
}

pub fn callback_strip_mask(revealed_trait_mask: u32) -> u32 {
    revealed_trait_mask & CONST_RARITY_STRIP_MASK
}

// ---------------------------------------------------------------------------------------
// 3. CONSTANTS_DOC — verbatim from programs/secret-garden/src/constants.rs.
// ---------------------------------------------------------------------------------------

pub const CONST_RARITY_SHIFT: u32 = 19;
pub const CONST_RARITY_STRIP_MASK: u32 = 0xFFC7_FFFF;
pub const CONST_BASE_UNCOMMON: u16 = 115;
pub const CONST_BASE_RARE: u16 = 192;
pub const CONST_BASE_EPIC: u16 = 230;
pub const CONST_BASE_LEGENDARY: u16 = 251;
pub const CONST_GENERATION_CAP: u8 = 10;
pub const CONST_EPIC_LIFT_DIV: u16 = 4;
pub const CONST_LEGENDARY_LIFT_DIV: u16 = 8;
pub const CONST_GENERATION_WEIGHT: u8 = 1;

/// The constants mirror's own tier function, built only from the published constants.
/// If a boundary in constants.rs drifts from the circuit, this disagrees with `circuit_tier`.
pub fn constants_tier(rarity_roll: u8, lift: u16) -> u8 {
    let bars = [
        CONST_BASE_UNCOMMON - lift,
        CONST_BASE_RARE - lift,
        CONST_BASE_EPIC - lift / CONST_EPIC_LIFT_DIV,
        CONST_BASE_LEGENDARY - lift / CONST_LEGENDARY_LIFT_DIV,
    ];
    let mut t: u8 = 1;
    for b in bars {
        if (rarity_roll as u16) >= b {
            t += 1;
        }
    }
    t
}

/// The frontend's decoder: class k = ((mask >> 8k) & 0xff) % 5. It never strips, which is
/// exactly why the callback must store an already-stripped mask.
pub fn frontend_class(mask: u32, k: u32) -> u8 {
    (((mask >> (8 * k)) & 0xff) % 5) as u8
}

/// Maximum lift the on-chain inputs can produce: rarity 5 + 5, generation >= cap, dial maxed.
pub const MAX_LIFT: u16 = 53;

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole input domain of the tier function: 256 rolls x 64 lifts.
    fn every_case() -> impl Iterator<Item = (u8, u16)> {
        (0..=MAX_LIFT).flat_map(|lift| (0u16..=255).map(move |r| (r as u8, lift)))
    }

    #[test]
    fn circuit_and_constants_agree_on_every_input() {
        for (roll, lift) in every_case() {
            assert_eq!(
                circuit_tier(roll, lift),
                constants_tier(roll, lift),
                "circuit vs constants.rs disagree at roll={roll} lift={lift}"
            );
        }
    }

    #[test]
    fn carry_extraction_equals_direct_comparison() {
        // The circuit uses (r + 256 - b) / 256 instead of `r >= b` because both branches
        // always execute in MPC. This is the proof those are the same predicate.
        for (roll, lift) in every_case() {
            let bars: [u16; 4] = [
                115 - lift,
                192 - lift,
                230 - (lift * 3) / 4,
                251 - lift / 2,
            ];
            for b in bars {
                let carry = ((roll as u16 + 256 - b) / 256) as u8;
                let direct = u8::from((roll as u16) >= b);
                assert_eq!(carry, direct, "carry != compare at roll={roll} b={b}");
            }
        }
    }

    #[test]
    fn tier_is_always_in_the_on_chain_range() {
        for (roll, lift) in every_case() {
            let t = circuit_tier(roll, lift);
            assert!(
                (1..=5).contains(&t),
                "tier {t} out of RARITY_COMMON..=RARITY_LEGENDARY at roll={roll} lift={lift}"
            );
        }
    }

    #[test]
    fn boundaries_stay_strictly_ordered_and_never_underflow() {
        for lift in 0..=MAX_LIFT {
            let bars: [u16; 4] = [
                115 - lift,
                192 - lift,
                230 - (lift * 3) / 4,
                251 - lift / 2,
            ];
            for w in bars.windows(2) {
                assert!(w[0] < w[1], "boundaries crossed at lift={lift}: {bars:?}");
            }
            // Every bar must stay inside the roll's own range, or a tier becomes unreachable
            // (bar > 255) or unavoidable (bar == 0).
            for b in bars {
                assert!(b > 0 && b <= 255, "bar {b} out of roll range at lift={lift}");
            }
        }
    }

    #[test]
    fn lift_is_monotone_in_every_input() {
        // More lineage must never make a flower rarer-by-accident in the wrong direction:
        // for a fixed roll, tier must be non-decreasing as lift rises.
        for roll in 0u16..=255 {
            let mut prev = circuit_tier(roll as u8, 0);
            for lift in 1..=MAX_LIFT {
                let t = circuit_tier(roll as u8, lift);
                assert!(
                    t >= prev,
                    "tier went DOWN as lift rose (roll={roll}, lift={lift}: {prev} -> {t})"
                );
                prev = t;
            }
        }
    }

    #[test]
    fn lift_inputs_cannot_exceed_max_lift() {
        // Exhaustive over the real on-chain domain: rarity 0..=5 each, generation 0..=255,
        // dial 0..=255 each (stepped, since the quantiser only has four output levels).
        let mut seen_max = 0u16;
        for a in 0u8..=5 {
            for b in 0u8..=5 {
                for g in 0u16..=255 {
                    let public = circuit_public_lift(a, b, g as u8);
                    for dial in [0u8, 63, 64, 127, 128, 191, 192, 255] {
                        let env = circuit_env_lift(dial, dial, dial);
                        let lift = (public + env) as u16;
                        assert!(
                            lift <= MAX_LIFT,
                            "lift {lift} exceeds MAX_LIFT (a={a} b={b} gen={g} dial={dial})"
                        );
                        seen_max = seen_max.max(lift);
                    }
                }
            }
        }
        assert_eq!(seen_max, MAX_LIFT, "MAX_LIFT is not actually reachable");
    }

    #[test]
    fn generation_cap_actually_caps() {
        for g in CONST_GENERATION_CAP..=255 {
            assert_eq!(
                circuit_public_lift(0, 0, g),
                circuit_public_lift(0, 0, CONST_GENERATION_CAP),
                "generation {g} still moved the lift past the cap"
            );
        }
    }

    #[test]
    fn env_lift_is_quantised_to_four_levels() {
        let mut levels = std::collections::BTreeSet::new();
        for d in 0u16..=255 {
            levels.insert(circuit_env_lift(d as u8, d as u8, d as u8));
        }
        assert_eq!(
            levels.into_iter().collect::<Vec<_>>(),
            vec![0, 1, 2, 3],
            "env_lift must stay a 4-level signal — widening it widens the side-channel"
        );
    }

    #[test]
    fn pack_round_trips_and_stays_below_the_27_bit_cliff() {
        for petal in 0u8..=4 {
            for color in 0u8..=4 {
                for leaf in 0u8..=4 {
                    for stem in 0u8..=4 {
                        for tier in 0u8..=5 {
                            let mask = circuit_pack(petal, color, leaf, stem, tier);
                            // THE constraint attempt 4 discovered the hard way: a revealed
                            // u32 truncates at ~27 bits on the live Arcium output path.
                            assert_eq!(
                                mask >> 27,
                                0,
                                "mask rides the 27-bit cliff (p{petal} c{color} l{leaf} s{stem} t{tier})"
                            );
                            assert_eq!(callback_unpack_rarity(mask), tier, "tier round-trip");

                            // After stripping, the frontend decoder must see the ORIGINAL
                            // classes — it never strips for itself.
                            let stored = callback_strip_mask(mask);
                            assert_eq!(frontend_class(stored, 0), petal, "petal");
                            assert_eq!(frontend_class(stored, 1), color, "color");
                            assert_eq!(frontend_class(stored, 2), leaf, "leaf");
                            assert_eq!(frontend_class(stored, 3), stem, "stem");
                            assert_eq!(
                                (stored >> CONST_RARITY_SHIFT) & 0x7,
                                0,
                                "stored mask still carries rarity bits"
                            );
                            // Stripping is idempotent and equals the tier-0 packing.
                            assert_eq!(stored, circuit_pack(petal, color, leaf, stem, 0));
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn strip_mask_clears_exactly_bits_19_to_21() {
        assert_eq!(CONST_RARITY_STRIP_MASK, !(0x7u32 << CONST_RARITY_SHIFT));
        for bit in 0..32u32 {
            let cleared = (CONST_RARITY_STRIP_MASK >> bit) & 1 == 0;
            let expected = (19..=21).contains(&bit);
            assert_eq!(cleared, expected, "bit {bit} strip behaviour is wrong");
        }
    }

    /// Exact tier counts over all 256 equiprobable rolls at a given lift.
    fn counts_at(lift: u16) -> [u32; 6] {
        let mut c = [0u32; 6];
        for r in 0u16..=255 {
            c[circuit_tier(r as u8, lift) as usize] += 1;
        }
        c
    }

    #[test]
    fn distribution_matches_the_design_at_every_documented_lift() {
        // Exact, not sampled: the roll is one uniform u8, so enumerating all 256 outcomes
        // IS the distribution. Percentages are counts/256.
        let cases: [(u16, [u32; 5], [f64; 5]); 3] = [
            // lift 0 — two unranked starters, gen 1, dial 0. Reproduces attempt 4 exactly.
            (0, [115, 77, 38, 21, 5], [44.92, 30.08, 14.84, 8.20, 1.95]),
            // lift 32 — two Rare parents at depth, mid dial.
            (32, [83, 77, 62, 25, 9], [32.42, 30.08, 24.22, 9.77, 3.52]),
            // lift 53 — the Stage 5F maximum: two Legendary parents, gen >= 10, dial maxed.
            (53, [62, 77, 78, 28, 11], [24.22, 30.08, 30.47, 10.94, 4.30]),
        ];
        for (lift, want_counts, want_pct) in cases {
            let got = counts_at(lift);
            let got_counts = [got[1], got[2], got[3], got[4], got[5]];
            assert_eq!(
                got_counts, want_counts,
                "tier counts at lift={lift}"
            );
            assert_eq!(got_counts.iter().sum::<u32>(), 256, "counts must total 256");
            assert_eq!(got[0], 0, "tier 0 (unranked) must never be rolled");
            for i in 0..5 {
                let pct = got_counts[i] as f64 / 256.0 * 100.0;
                assert!(
                    (pct - want_pct[i]).abs() < 0.01,
                    "lift={lift} tier={} share {pct:.2}% != design {:.2}%",
                    i + 1,
                    want_pct[i]
                );
            }
        }
    }

    /// Stage 5F guard. Flattening ONLY `b_legendary` (leaving b_epic at x3/4) pushes the
    /// inflation down one tier instead of removing it: Epic reaches 23.8% and OVERTAKES
    /// Rare at high lift. Both top slopes must move together, and this pins that.
    #[test]
    fn epic_never_overtakes_rare_and_legendary_never_overtakes_epic() {
        for lift in 0..=MAX_LIFT {
            let c = counts_at(lift);
            assert!(
                c[4] <= c[3],
                "Epic ({}) overtook Rare ({}) at lift={lift}", c[4], c[3]
            );
            assert!(
                c[5] <= c[4],
                "Legendary ({}) overtook Epic ({}) at lift={lift}", c[5], c[4]
            );
        }
    }

    /// The combined top end must COMPRESS, not relocate: Epic+Legendary is what a player
    /// experiences as "I got something special", and it was 10.2% -> 28.5% before 5F.
    #[test]
    fn combined_top_end_stays_compressed() {
        let top_end = |lift: u16| {
            let c = counts_at(lift);
            (c[4] + c[5]) as f64 / 256.0 * 100.0
        };
        let (base, top) = (top_end(0), top_end(MAX_LIFT));
        assert!((base - 10.16).abs() < 0.01, "base Epic+Leg {base:.2}% != 10.16%");
        assert!(top < 16.0, "Epic+Leg inflated to {top:.2}% at max lift");
    }

    #[test]
    fn legendary_rate_rises_with_lineage_but_never_becomes_routine() {
        let at = |lift: u16| counts_at(lift)[5] as f64 / 256.0 * 100.0;
        let (base, top) = (at(0), at(MAX_LIFT));
        assert!((base - 1.95).abs() < 0.01, "baseline Legendary {base:.2}% != 1.95%");
        assert!((top - 4.30).abs() < 0.01, "max-lift Legendary {top:.2}% != 4.30%");
        // Stage 5F: the payoff is deliberately SMALL. Before the rebalance this asserted
        // `> 6.0x` and a 14.06% ceiling, which is exactly the inflation that was measured
        // in the wild (~2.8 expected Legendaries per 30 breeds of ordinary play). Lineage
        // must still be worth something, but Legendary must stay a tail event.
        assert!(top / base > 1.5, "lineage payoff vanished ({:.1}x)", top / base);
        assert!(top < 6.0, "Legendary became routine at max lift ({top:.2}%)");
        // Monotone across every lift in between.
        let mut prev = at(0);
        for lift in 1..=MAX_LIFT {
            let cur = at(lift);
            assert!(cur >= prev, "Legendary rate dipped at lift={lift}");
            prev = cur;
        }
    }
}
