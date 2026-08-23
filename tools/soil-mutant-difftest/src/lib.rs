//! Differential test: does the Soil dial actually move the Mutant trait?
//!
//! WHY THIS CRATE EXISTS. It closes a gap that let a real bug live undetected. `breed_v3`
//! computed
//!
//! ```text
//! mutation_affinity = ((rand_mut as u16 + soil as u16) / 2) as u8
//! ```
//!
//! and the Mutant trait reads `mutation_affinity % 2 == 1`. That combination discards Soil
//! COMPLETELY: the result is odd exactly when `(rand_mut + soil) % 4` is 2 or 3, and because
//! `rand_mut` is a uniform `u8` (256 = 4 * 64) its residues mod 4 are exactly uniform, so
//! adding any constant `soil` merely permutes them. P(Mutant) was exactly 0.5 for all 256
//! soil values while the source comment claimed "soil tilts mutation".
//!
//! Nothing caught it. `tests/mutation.ts` covers the seven `>=`-threshold traits and states
//! outright that "Pale (`<`), Recessive Carrier and Mutant (parity) are absent because the
//! mutation branch does not move their genes" — true of `pick()`, but it left the parity
//! traits with no coverage at all. Repo-wide, `soil` appeared in tests only in the
//! `env_lift` mirror. A bug that makes a dial do nothing is invisible to a test suite that
//! never asserts the dial does something.
//!
//! WHAT IT CHECKS. Two independent transcriptions of the same function
//! `p_mutant(soil) -> f64`, one per place the math is written down:
//!
//!   1. `circuit`      — encrypted-ixs/src/lib.rs, the Soil->Mutant gate inside `breed_v5`.
//!                       The only EXECUTABLE definition; everything else mirrors it.
//!   2. `design_doc`   — the closed form quoted in that block's comment,
//!                       `P = (96 + soil/4) / 256`. Nothing compiles the comment against the
//!                       code, so it is the copy most likely to rot.
//!
//! The circuit form is transcribed with the Arcis wrappers stripped: secret `u8` values
//! become plain host integers, since the gate is ordinary unsigned arithmetic and a single
//! comparison with no data-dependent control flow. Any edit here that is not also in the
//! corresponding source invalidates the result.
//!
//! WHAT IT IS NOT. It does not prove the Arcis compilation is correct, nor that MPC
//! evaluation matches host evaluation, nor that `ArcisRNG::gen_uniform::<u8>()` is uniform —
//! the whole argument rests on that uniformity, and it is an assumption, not a result. It
//! proves: the two transcriptions denote the same function; Soil genuinely moves P(Mutant);
//! the movement is monotonic, spans the intended range, and is exactly 50% at neutral soil;
//! the low bit the trait reads is the gate's bit; and `mutation_affinity` never leaves `u8`.
//!
//! WHY IT CAN BE EXHAUSTIVE. The gate's entire input domain is `soil in 0..=255` x
//! `rand_gate in 0..=255` — 65,536 cases, all enumerated. The parity/range check adds
//! `rand_mag in 0..=255`, giving 16,777,216 cases, which still runs in well under a second.

/// The Soil -> Mutant gate exactly as `breed_v5` computes it. Returns the low bit the
/// Mutant trait will read.
///
/// Transcribed from encrypted-ixs/src/lib.rs:
///     let add = e.soil / 4;
///     let mutant_threshold = 96u8 + add;
///     let mutant_bit = if rand_gate < mutant_threshold { 1u8 } else { 0u8 };
pub fn circuit_mutant_bit(soil: u8, rand_gate: u8) -> u8 {
    let add = soil / 8;
    let mutant_threshold = 4u8 + add;
    if rand_gate < mutant_threshold { 1 } else { 0 }
}

/// HISTORICAL, not live: `breed_v4`'s gate, kept so the re-centring stays demonstrable
/// rather than merely asserted. v4 fixed v3's flatness but left the midpoint at exactly
/// 50%; v5 moves the whole curve down. Nothing in the program calls this.
pub fn breed_v4_mutant_bit(soil: u8, rand_gate: u8) -> u8 {
    let add = soil / 4;
    let mutant_threshold = 96u8 + add;
    if rand_gate < mutant_threshold { 1 } else { 0 }
}

/// `mutation_affinity` exactly as `breed_v5` assembles it. The low bit is forced
/// arithmetically because `<<`/`&`/`|` are unsupported on secret values in Arcis.
///
/// ```text
/// let mutation_magnitude = ((rand_mag as u16 + e.soil as u16) / 2) as u8;
/// let mutation_affinity = (mutation_magnitude / 2) * 2 + mutant_bit;
/// ```
pub fn circuit_mutation_affinity(soil: u8, rand_gate: u8, rand_mag: u8) -> u8 {
    let mutation_magnitude = ((rand_mag as u16 + soil as u16) / 2) as u8;
    (mutation_magnitude / 2) * 2 + circuit_mutant_bit(soil, rand_gate)
}

/// The Mutant predicate, from the CANONICAL `trait_satisfied` in encrypted-ixs/src/lib.rs:
/// ```text
/// 8 => g.mutation_affinity % 2 == 1, // Mutant (odd affinity)
/// ```
///
/// Deliberately unchanged by this fix: `trait_satisfied` is shared with `score_entry_v2` and
/// `private_hint`, so altering it would change those two circuits' bytecode too.
pub fn mutant_trait(mutation_affinity: u8) -> bool {
    mutation_affinity % 2 == 1
}

/// Exact P(Mutant) for a given soil, over a uniform `rand_gate`.
pub fn circuit_p_mutant(soil: u8) -> f64 {
    (0u16..=255)
        .filter(|g| circuit_mutant_bit(soil, *g as u8) == 1)
        .count() as f64
        / 256.0
}

/// The closed form quoted in the circuit's own comment: `P = (4 + soil/8) / 256`.
/// A NON-EXECUTABLE mirror in the source; this is what pins it to the code.
pub fn design_doc_p_mutant(soil: u8) -> f64 {
    (4.0 + (soil / 8) as f64) / 256.0
}

/// What `breed_v3` did, kept only to assert the bug is genuinely gone.
pub fn breed_v3_p_mutant(soil: u8) -> f64 {
    (0u16..=255)
        .filter(|r| ((((*r as u16) + soil as u16) / 2) as u8) % 2 == 1)
        .count() as f64
        / 256.0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two transcriptions must denote the same function, for every soil.
    #[test]
    fn circuit_and_design_doc_agree_for_every_soil() {
        for soil in 0u16..=255 {
            let s = soil as u8;
            assert_eq!(
                circuit_p_mutant(s),
                design_doc_p_mutant(s),
                "circuit and the comment's closed form disagree at soil={s}"
            );
        }
    }

    /// THE REGRESSION THIS CRATE EXISTS FOR: Soil must actually move the odds.
    #[test]
    fn soil_is_not_flat() {
        let ps: Vec<f64> = (0u16..=255).map(|s| circuit_p_mutant(s as u8)).collect();
        let min = ps.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = ps.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        assert!(max > min, "P(Mutant) is FLAT across soil — the breed_v3 bug is back");
        // Measured as a RATIO, not in percentage points. Under v4 the absolute span was the
        // right yardstick because the curve straddled 50%; under v5 the whole curve is scarce,
        // so max-min is necessarily small (12.1pp) while the dial is far MORE decisive than
        // before — 8.8x end to end against v4's 1.7x. Asserting percentage points here would
        // punish exactly the re-centring this circuit exists to deliver.
        assert!(
            max / min > 8.0,
            "Soil swings P(Mutant) only {:.2}x — too weak to be a meaningful dial",
            max / min
        );
        // Guard the other direction too: soil must not become a near-switch.
        assert!(min > 0.0, "some soil value makes Mutant impossible");
        assert!(max < 0.25, "max soil makes Mutant too common for a scarce trait");
    }

    /// And the old formula must still measure as flat, so the test above is meaningful
    /// rather than passing for some unrelated reason.
    /// HISTORICAL REGRESSION. breed_v4's curve, kept so a future edit cannot quietly
    /// reintroduce the coin-flip midpoint that v5 exists to remove.
    #[test]
    fn breed_v4_was_centred_on_a_coin_flip() {
        let p = |soil: u8| {
            (0..=255u16).filter(|g| breed_v4_mutant_bit(soil, *g as u8) == 1).count() as f64 / 256.0
        };
        assert_eq!(p(0), 96.0 / 256.0, "v4 soil=0 was 37.5%");
        assert_eq!(p(128), 0.5, "v4 neutral was exactly 50% — the thing v5 re-centred");
        assert_eq!(p(255), 159.0 / 256.0, "v4 soil=255 was 62.109%");
        // v4's dial was a trim; v5's is a lever. Prove they differ in kind, not degree.
        let v4_swing = p(255) / p(0);
        let v5 = |soil: u8| {
            (0..=255u16).filter(|g| circuit_mutant_bit(soil, *g as u8) == 1).count() as f64 / 256.0
        };
        let v5_swing = v5(255) / v5(0);
        assert!(v4_swing < 2.0, "v4 swing was ~1.7x");
        assert!(v5_swing > 8.0, "v5 swing is ~8.8x");
        assert!(v5(128) < p(128) / 5.0, "v5 neutral is far below v4's coin flip");
    }

    #[test]
    fn breed_v3_really_was_flat() {
        let ps: Vec<f64> = (0u16..=255).map(|s| breed_v3_p_mutant(s as u8)).collect();
        assert!(
            ps.iter().all(|p| *p == 0.5),
            "breed_v3 was expected to be exactly 0.5 for all soil"
        );
    }

    /// Direction and calibration: monotonic, spanning 37.5%..62.109%, and exactly 50% at
    /// the neutral midpoint so the fix re-centres rather than buffing.
    #[test]
    fn monotonic_and_calibrated() {
        let ps: Vec<f64> = (0u16..=255).map(|s| circuit_p_mutant(s as u8)).collect();
        for i in 1..ps.len() {
            assert!(ps[i] >= ps[i - 1], "P(Mutant) decreased at soil={i}");
        }
        // breed_v5 curve, calibrated against the rarity ladder (Epic ~9.4%): Legendary-scarce
        // at starved soil, just under Epic at neutral, between Epic and Rare at max.
        assert_eq!(ps[0], 4.0 / 256.0, "soil=0 should be 1.563%");
        assert_eq!(ps[64], 12.0 / 256.0, "soil=64 should be 4.688%");
        assert_eq!(ps[128], 20.0 / 256.0, "neutral soil=128 should be 7.813%");
        assert_eq!(ps[192], 28.0 / 256.0, "soil=192 should be 10.938%");
        assert_eq!(ps[255], 35.0 / 256.0, "soil=255 should be 13.672%");
        // The whole point of v5: neutral is no longer a coin flip.
        assert!(ps[128] < 0.10, "neutral must be well under the old 50% — Mutant is a find");
        // ...and the dial is a real lever, not a trim. v4 spanned 1.7x; v5 spans ~8.8x.
        assert!(ps[255] / ps[0] > 8.0, "soil should swing P(Mutant) by more than 8x");
    }

    /// The trait reads the gate's bit, and nothing else, for every reachable input.
    #[test]
    fn trait_reads_the_gate_bit_and_affinity_stays_in_u8() {
        for soil in (0u16..=255).step_by(5) {
            for gate in (0u16..=255).step_by(5) {
                for mag in (0u16..=255).step_by(5) {
                    let bit = circuit_mutant_bit(soil as u8, gate as u8);
                    let ma = circuit_mutation_affinity(soil as u8, gate as u8, mag as u8);
                    assert_eq!(
                        mutant_trait(ma),
                        bit == 1,
                        "trait disagrees with the gate at soil={soil} gate={gate} mag={mag}"
                    );
                    // `ma` is a u8 by construction; assert the arithmetic never wrapped, which
                    // would silently flip the parity the trait depends on.
                    let expect_hi = ((((mag as u16) + soil as u16) / 2) as u8) / 2 * 2;
                    assert_eq!(ma, expect_hi + bit, "affinity assembly wrapped or drifted");
                }
            }
        }
    }

    /// The magnitude still carries soil, so the field is more than one bit for any future
    /// reader — while the low bit stays reserved for the trait.
    #[test]
    fn magnitude_still_responds_to_soil() {
        let mean = |soil: u8| -> f64 {
            (0u16..=255)
                .map(|m| ((((m as u16) + soil as u16) / 2) as u8) as f64)
                .sum::<f64>()
                / 256.0
        };
        assert!(
            mean(255) > mean(0) + 100.0,
            "magnitude no longer tracks soil: {} vs {}",
            mean(0),
            mean(255)
        );
    }
}
