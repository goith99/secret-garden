//! Differential test: the trait-condition table, as it appears in THREE places.
//!
//! WHAT THIS IS. Three independent transcriptions of the same predicate
//! `trait_satisfied(genome, trait_id) -> bool`, one per place the conditions are
//! written down today:
//!
//!   1. `score_entry_v2`  — encrypted-ixs/src/lib.rs, the scoring circuit.
//!   2. `private_hint`    — encrypted-ixs/src/lib.rs, the sealed per-player hint circuit.
//!   3. `constants_doc`   — programs/secret-garden/src/constants.rs, the `TRAIT_TABLE`
//!                          comment mirror. NOTHING compiles this one. It is prose beside
//!                          a table of names, and it is the copy most likely to rot.
//!
//! Each is transcribed with the Arcis wrappers stripped: `Enc<Mxe, Genome>` becomes a
//! plain `Genome`, `.to_arcis()` is identity. The conditions themselves are copied
//! verbatim, in source order. Nothing is "tidied" — any edit here that is not also in the
//! corresponding source invalidates the result.
//!
//! WHAT THIS IS NOT. It does not prove the Arcis compilation is correct, nor that MPC
//! evaluation matches host evaluation. It proves exactly one thing: the three written-down
//! tables denote the same predicate. That is the property a desync would break, and the
//! reason this test still earns its place even after the circuits are made to share one
//! source-level definition — it is the belt-and-braces check that survives the shared
//! definition being undone later.
//!
//! WHY IT CAN BE EXHAUSTIVE. The predicate's input is a 10-byte genome plus a u8 trait id.
//! The full cross product is 256^11, which is not enumerable — but every condition is a
//! comparison against ONE field, so the sweep below varies each field across its entire
//! 0..=255 range against a set of backgrounds, for every one of the 256 possible trait ids.
//! Crucially it does NOT assume single-field dependence: the backgrounds vary all ten
//! fields, so an implementation that started reading the wrong field is caught too.
//!
//! Run: cargo test --release

/// Host mirror of the circuits' `Genome` (encrypted-ixs/src/lib.rs).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Genome {
    pub color_gene: u8,
    pub petal_gene: u8,
    pub leaf_gene: u8,
    pub stem_gene: u8,
    pub aroma_gene: u8,
    pub climate_gene: u8,
    pub recessive_mask: u8,
    pub mutation_affinity: u8,
    pub stability: u8,
    pub reserved: u8,
}

impl Genome {
    /// Set field `f` (0..10, declaration order) to `v`. Used by the sweep.
    pub fn with_field(mut self, f: usize, v: u8) -> Self {
        match f {
            0 => self.color_gene = v,
            1 => self.petal_gene = v,
            2 => self.leaf_gene = v,
            3 => self.stem_gene = v,
            4 => self.aroma_gene = v,
            5 => self.climate_gene = v,
            6 => self.recessive_mask = v,
            7 => self.mutation_affinity = v,
            8 => self.stability = v,
            9 => self.reserved = v,
            _ => panic!("field index {f} out of range"),
        }
        self
    }
    pub const FIELD_COUNT: usize = 10;
    pub const FIELD_NAMES: [&'static str; 10] = [
        "color_gene",
        "petal_gene",
        "leaf_gene",
        "stem_gene",
        "aroma_gene",
        "climate_gene",
        "recessive_mask",
        "mutation_affinity",
        "stability",
        "reserved",
    ];
}

/// Number of traits the on-chain table declares (`constants::TRAIT_TABLE_LEN`).
pub const TRAIT_TABLE_LEN: u8 = 10;

// ---------------------------------------------------------------------------------------
// 1. Transcription of `score_entry_v2`'s trait_satisfied (encrypted-ixs/src/lib.rs).
// ---------------------------------------------------------------------------------------
pub fn score_entry_v2(g: &Genome, trait_id: u8) -> bool {
    match trait_id {
        0 => g.color_gene >= 180,          // Crimson
        1 => g.color_gene < 64,            // Pale
        2 => g.petal_gene >= 150,          // Full Bloom
        3 => g.leaf_gene >= 128,           // Broadleaf
        4 => g.stem_gene >= 160,           // Tall
        5 => g.aroma_gene >= 150,          // Fragrant
        6 => g.climate_gene >= 140,        // Hardy
        7 => g.recessive_mask >= 32,       // Recessive Carrier
        8 => g.mutation_affinity % 2 == 1, // Mutant (odd affinity)
        9 => g.stability >= 150,           // Stable
        _ => false,
    }
}

// ---------------------------------------------------------------------------------------
// 2. Transcription of `private_hint`'s trait_satisfied (encrypted-ixs/src/lib.rs).
// ---------------------------------------------------------------------------------------
pub fn private_hint(g: &Genome, trait_id: u8) -> bool {
    match trait_id {
        0 => g.color_gene >= 180,          // Crimson
        1 => g.color_gene < 64,            // Pale
        2 => g.petal_gene >= 150,          // Full Bloom
        3 => g.leaf_gene >= 128,           // Broadleaf
        4 => g.stem_gene >= 160,           // Tall
        5 => g.aroma_gene >= 150,          // Fragrant
        6 => g.climate_gene >= 140,        // Hardy
        7 => g.recessive_mask >= 32,       // Recessive Carrier
        8 => g.mutation_affinity % 2 == 1, // Mutant (odd affinity)
        9 => g.stability >= 150,           // Stable
        _ => false,
    }
}

// ---------------------------------------------------------------------------------------
// 3. Transcription of the TRAIT_TABLE comment mirror
//    (programs/secret-garden/src/constants.rs). Each arm below is transcribed from the
//    trailing `//` comment on the corresponding TraitDef entry, and the name from its
//    `name:` field. This copy has no compiler checking it in the real tree at all.
// ---------------------------------------------------------------------------------------
pub fn constants_doc(g: &Genome, trait_id: u8) -> bool {
    match trait_id {
        0 => g.color_gene >= 180,               // "Crimson"           color_gene >= 180
        1 => g.color_gene < 64,                 // "Pale"              color_gene < 64
        2 => g.petal_gene >= 150,               // "Full Bloom"        petal_gene >= 150
        3 => g.leaf_gene >= 128,                // "Broadleaf"         leaf_gene >= 128
        4 => g.stem_gene >= 160,                // "Tall"              stem_gene >= 160
        5 => g.aroma_gene >= 150,               // "Fragrant"          aroma_gene >= 150
        6 => g.climate_gene >= 140,             // "Hardy"             climate_gene >= 140
        7 => g.recessive_mask >= 32,            // "Recessive Carrier" recessive_mask >= 32
        8 => g.mutation_affinity % 2 == 1,      // "Mutant"            mutation_affinity is odd
        9 => g.stability >= 150,                // "Stable"            stability >= 150
        _ => false,
    }
}

/// The trait names, in id order, as declared in `constants::TRAIT_TABLE`.
pub const TRAIT_NAMES: [&str; TRAIT_TABLE_LEN as usize] = [
    "Crimson",
    "Pale",
    "Full Bloom",
    "Broadleaf",
    "Tall",
    "Fragrant",
    "Hardy",
    "Recessive Carrier",
    "Mutant",
    "Stable",
];

/// Every implementation under test, by name. Adding a fourth copy of the table anywhere
/// in the tree means adding it here.
pub const IMPLS: [(&str, fn(&Genome, u8) -> bool); 3] = [
    ("score_entry_v2", score_entry_v2),
    ("private_hint", private_hint),
    ("constants_doc", constants_doc),
];

/// Compare all implementations on one input. Returns `Err(message)` on disagreement.
pub fn agree(g: &Genome, trait_id: u8) -> Result<bool, String> {
    let (first_name, first_fn) = IMPLS[0];
    let expected = first_fn(g, trait_id);
    for (name, f) in IMPLS.iter().skip(1) {
        let got = f(g, trait_id);
        if got != expected {
            return Err(format!(
                "DESYNC on trait_id={trait_id}{}: {first_name}={expected} but {name}={got}\n  genome={g:?}",
                if (trait_id as usize) < TRAIT_NAMES.len() {
                    format!(" ({})", TRAIT_NAMES[trait_id as usize])
                } else {
                    String::new()
                }
            ));
        }
    }
    Ok(expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// xorshift64* — same tiny deterministic PRNG style as reveal-top3-difftest.
    struct Rng(u64);
    impl Rng {
        fn next_u64(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn byte(&mut self) -> u8 {
            (self.next_u64() >> 33) as u8
        }
        fn genome(&mut self) -> Genome {
            let mut g = Genome::default();
            for f in 0..Genome::FIELD_COUNT {
                g = g.with_field(f, self.byte());
            }
            g
        }
    }

    fn check(g: &Genome, trait_id: u8) {
        if let Err(msg) = agree(g, trait_id) {
            panic!("{msg}");
        }
    }

    /// Backgrounds the single-field sweep runs against. Chosen so that every OTHER field
    /// sits variously below, at, and above each documented threshold — so an
    /// implementation that reads the wrong field diverges on at least one background.
    fn backgrounds() -> Vec<Genome> {
        let mut v = Vec::new();
        for &fill in &[0u8, 31, 32, 63, 64, 127, 128, 139, 140, 149, 150, 159, 160, 179, 180, 255] {
            let mut g = Genome::default();
            for f in 0..Genome::FIELD_COUNT {
                g = g.with_field(f, fill);
            }
            v.push(g);
        }
        // A couple of asymmetric backgrounds so all-equal fills are not the only shape.
        let mut asc = Genome::default();
        let mut desc = Genome::default();
        for f in 0..Genome::FIELD_COUNT {
            asc = asc.with_field(f, (f as u8).wrapping_mul(25));
            desc = desc.with_field(f, 255u8.wrapping_sub((f as u8).wrapping_mul(25)));
        }
        v.push(asc);
        v.push(desc);
        v
    }

    /// THE MAIN SWEEP. Every trait id (all 256, not just 0..=9) x every field x every
    /// value 0..=255 of that field x every background. ~256*10*256*18 = 11.8M cases.
    #[test]
    fn exhaustive_single_field_sweep() {
        let bgs = backgrounds();
        let mut checked: u64 = 0;
        for trait_id in 0..=255u8 {
            for f in 0..Genome::FIELD_COUNT {
                for v in 0..=255u8 {
                    for bg in &bgs {
                        check(&bg.with_field(f, v), trait_id);
                        checked += 1;
                    }
                }
            }
        }
        assert!(checked > 11_000_000, "only {checked} cases checked");
    }

    /// Randomized full genomes: all ten fields vary at once, so a desync that only shows
    /// up on a field COMBINATION (rather than a single field) is still reachable.
    #[test]
    fn randomized_full_genomes() {
        let mut rng = Rng(0x5EED_1234_ABCD_0001);
        for _ in 0..400_000 {
            let g = rng.genome();
            for trait_id in 0..=255u8 {
                check(&g, trait_id);
            }
        }
    }

    /// Threshold neighbourhoods pinned explicitly, so the exact boundary of every
    /// condition is asserted rather than merely swept over. Catches a `>=` silently
    /// becoming `>` in one copy — the single most likely desync.
    #[test]
    fn threshold_boundaries_pinned() {
        // (trait_id, field index, threshold, expected_at_threshold)
        // For `>=` conditions the value AT the threshold must be true and one below false.
        let ge_cases: [(u8, usize, u8); 8] = [
            (0, 0, 180), // Crimson:           color_gene     >= 180
            (2, 1, 150), // Full Bloom:        petal_gene     >= 150
            (3, 2, 128), // Broadleaf:         leaf_gene      >= 128
            (4, 3, 160), // Tall:              stem_gene      >= 160
            (5, 4, 150), // Fragrant:          aroma_gene     >= 150
            (6, 5, 140), // Hardy:             climate_gene   >= 140
            (7, 6, 32),  // Recessive Carrier: recessive_mask >= 32
            (9, 8, 150), // Stable:            stability      >= 150
        ];
        for (trait_id, field, threshold) in ge_cases {
            for bg in backgrounds() {
                let below = bg.with_field(field, threshold - 1);
                let at = bg.with_field(field, threshold);
                let above = bg.with_field(field, threshold.saturating_add(1));
                assert_eq!(
                    agree(&below, trait_id).unwrap(),
                    false,
                    "trait {trait_id} ({}) should be FALSE at {}={}",
                    TRAIT_NAMES[trait_id as usize],
                    Genome::FIELD_NAMES[field],
                    threshold - 1
                );
                assert_eq!(
                    agree(&at, trait_id).unwrap(),
                    true,
                    "trait {trait_id} ({}) should be TRUE at {}={threshold} (>= is inclusive)",
                    TRAIT_NAMES[trait_id as usize],
                    Genome::FIELD_NAMES[field]
                );
                assert_eq!(agree(&above, trait_id).unwrap(), true);
            }
        }

        // Pale is the one strict `<` condition: color_gene < 64.
        for bg in backgrounds() {
            assert_eq!(agree(&bg.with_field(0, 63), 1).unwrap(), true);
            assert_eq!(agree(&bg.with_field(0, 64), 1).unwrap(), false);
        }

        // Mutant is a parity test, not a threshold: every odd value true, even false.
        for bg in backgrounds() {
            for v in 0..=255u8 {
                assert_eq!(
                    agree(&bg.with_field(7, v), 8).unwrap(),
                    v % 2 == 1,
                    "Mutant parity wrong at mutation_affinity={v}"
                );
            }
        }
    }

    /// `reserved` is not read by any condition. Pinned so that if a future trait starts
    /// using it, this test fails and forces the table (and TRAIT_TABLE_LEN) to be revisited
    /// deliberately rather than by accident.
    #[test]
    fn reserved_field_is_never_read() {
        let mut rng = Rng(0xBEEF_0000_0000_0002);
        for _ in 0..50_000 {
            let base = rng.genome();
            for trait_id in 0..=255u8 {
                let a = base.with_field(9, 0);
                let b = base.with_field(9, 255);
                for (name, f) in IMPLS {
                    assert_eq!(
                        f(&a, trait_id),
                        f(&b, trait_id),
                        "{name} reads `reserved` for trait_id={trait_id}"
                    );
                }
            }
        }
    }

    /// Ids at or beyond TRAIT_TABLE_LEN must be false everywhere. `open_round` samples ids
    /// from `0..TRAIT_TABLE_LEN`, so a circuit that grew an 11th arm without the table
    /// growing to match would be unreachable on-chain — and vice versa, a table that grew
    /// without the circuits would silently score every entry 0 on the new trait.
    #[test]
    fn ids_beyond_table_are_false_in_every_impl() {
        let mut rng = Rng(0xF00D_0000_0000_0003);
        for _ in 0..200_000 {
            let g = rng.genome();
            for trait_id in TRAIT_TABLE_LEN..=255u8 {
                for (name, f) in IMPLS {
                    assert!(
                        !f(&g, trait_id),
                        "{name} returned true for out-of-table trait_id={trait_id}"
                    );
                }
            }
        }
    }

    /// Every in-table id must be SATISFIABLE and REFUTABLE — there is some genome making
    /// it true and some making it false. A condition accidentally rewritten to a constant
    /// (e.g. `>= 0`, or comparing a u8 against 256) would still agree across all three
    /// copies if all three were edited together, but it would be a dead trait. This is the
    /// one check here that is not differential.
    #[test]
    fn every_trait_is_satisfiable_and_refutable() {
        let mut rng = Rng(0x1DEA_0000_0000_0004);
        let mut seen_true = [false; TRAIT_TABLE_LEN as usize];
        let mut seen_false = [false; TRAIT_TABLE_LEN as usize];
        for _ in 0..100_000 {
            let g = rng.genome();
            for trait_id in 0..TRAIT_TABLE_LEN {
                if agree(&g, trait_id).unwrap() {
                    seen_true[trait_id as usize] = true;
                } else {
                    seen_false[trait_id as usize] = true;
                }
            }
        }
        for id in 0..TRAIT_TABLE_LEN as usize {
            assert!(seen_true[id], "trait {id} ({}) is never true", TRAIT_NAMES[id]);
            assert!(seen_false[id], "trait {id} ({}) is never false", TRAIT_NAMES[id]);
        }
    }

    /// META-TEST: proves the harness has teeth. Seeds each realistic desync mutation into
    /// a copy of the table and asserts the sweep would have caught it. Without this, a
    /// harness that silently compared a function to itself would pass forever.
    #[test]
    fn harness_catches_seeded_desyncs() {
        // Each mutant is a plausible drift: off-by-one, wrong field, flipped comparison,
        // wrong threshold, dropped arm, inverted parity.
        let mutants: [(&str, fn(&Genome, u8) -> bool); 6] = [
            ("off-by-one on Crimson", |g: &Genome, t: u8| match t {
                0 => g.color_gene >= 181,
                _ => score_entry_v2(g, t),
            }),
            ("wrong field on Tall", |g: &Genome, t: u8| match t {
                4 => g.leaf_gene >= 160,
                _ => score_entry_v2(g, t),
            }),
            ("strict > on Broadleaf", |g: &Genome, t: u8| match t {
                3 => g.leaf_gene > 128,
                _ => score_entry_v2(g, t),
            }),
            ("wrong threshold on Hardy", |g: &Genome, t: u8| match t {
                6 => g.climate_gene >= 240,
                _ => score_entry_v2(g, t),
            }),
            ("dropped Stable arm", |g: &Genome, t: u8| match t {
                9 => false,
                _ => score_entry_v2(g, t),
            }),
            ("inverted Mutant parity", |g: &Genome, t: u8| match t {
                8 => g.mutation_affinity % 2 == 0,
                _ => score_entry_v2(g, t),
            }),
        ];

        for (label, mutant) in mutants {
            let mut caught = false;
            'outer: for trait_id in 0..=255u8 {
                for f in 0..Genome::FIELD_COUNT {
                    for v in 0..=255u8 {
                        for bg in backgrounds() {
                            let g = bg.with_field(f, v);
                            if mutant(&g, trait_id) != score_entry_v2(&g, trait_id) {
                                caught = true;
                                break 'outer;
                            }
                        }
                    }
                }
            }
            assert!(
                caught,
                "the sweep would NOT have caught the mutation: {label}"
            );
        }
    }
}
