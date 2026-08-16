//! Differential test: `reveal_top3` (live) vs `reveal_top3_v2` (candidate rewrite).
//!
//! WHAT THIS IS. Both functions below are line-for-line transcriptions of the two
//! circuits in `encrypted-ixs/src/lib.rs`, with the Arcis wrappers stripped:
//! `Enc<Mxe, u8>` inputs become a plain `[u8; 16]`, `.to_arcis()` and `.reveal()` become
//! identity, and the select-style `if`/`else` expressions are kept verbatim. Nothing else
//! is changed — no reordering, no "obvious" simplification. The point is to compare the
//! ALGORITHMS, so any edit here that is not also in the circuit invalidates the result.
//!
//! WHAT THIS IS NOT. It does not prove the Arcis compilation of either circuit is
//! correct, nor that MPC evaluation matches host evaluation. It proves exactly one
//! thing: the two algorithms compute the same function. That is the property the rewrite
//! needs, and the property a cluster run would be a slow and expensive way to test.
//!
//! Run: cargo test --release   (release matters — the exhaustive sweep is ~1M cases)

/// `(slot1, score1, slot2, score2, slot3, score3)` — the circuits' return type.
pub type Out = (u16, u8, u16, u8, u16, u8);

/// Transcription of the LIVE `reveal_top3` (encrypted-ixs/src/lib.rs:490-574).
///
/// Ranks every slot by how many slots beat it, then reads off ranks 0, 1, 2.
/// ~304 comparisons (16x16 rank + 3x16 selection), independent of `participant_count`.
pub fn old(raw: [u8; 16], participant_count: u8) -> Out {
    // Mask inactive slots to 0.
    let mut s = [0u8; 16];
    for i in 0..16 {
        let active = (i as u8) < participant_count;
        s[i] = if active { raw[i] } else { 0u8 };
    }

    // Rank each slot by how many slots beat it (strict score, ties broken by lower index).
    let mut rank = [0u16; 16];
    for i in 0..16 {
        let mut r: u16 = 0;
        for j in 0..16 {
            let beats = (s[j] > s[i]) || ((s[j] == s[i]) && (j < i));
            if beats {
                r += 1;
            }
        }
        rank[i] = r;
    }

    // Select the SLOT index at each of ranks 0, 1, 2.
    let mut top_slot = [0u16; 3];
    let mut top_score = [0u8; 3];
    for k in 0..3 {
        let mut found_slot: u16 = 0;
        let mut found_score: u8 = 0;
        for i in 0..16 {
            let is_k = rank[i] == (k as u16);
            found_slot = if is_k { i as u16 } else { found_slot };
            found_score = if is_k { s[i] } else { found_score };
        }
        top_slot[k] = found_slot;
        top_score[k] = found_score;
    }

    (
        top_slot[0],
        top_score[0],
        top_slot[1],
        top_score[1],
        top_slot[2],
        top_score[2],
    )
}

/// Transcription of the CANDIDATE `reveal_top3_v2`.
///
/// Seeds a running top-3 from slots 0,1,2 (stably sorted) then folds slots 3..15 in with
/// at most three strict comparisons each. ~42 comparisons total.
pub fn new(raw: [u8; 16], participant_count: u8) -> Out {
    // Mask inactive slots to 0. Identical to `old`.
    let mut s = [0u8; 16];
    for i in 0..16 {
        let active = (i as u8) < participant_count;
        s[i] = if active { raw[i] } else { 0u8 };
    }

    // --- seed: slots 0,1,2 stably sorted descending by score ---
    let zero_first = s[0] >= s[1];
    let a_score = if zero_first { s[0] } else { s[1] };
    let a_slot: u16 = if zero_first { 0 } else { 1 };
    let b_score = if zero_first { s[1] } else { s[0] };
    let b_slot: u16 = if zero_first { 1 } else { 0 };

    let c_before_a = s[2] > a_score;
    let c_before_b = s[2] > b_score;
    let mut ts = [0u8; 3];
    let mut tl = [0u16; 3];
    ts[0] = if c_before_a { s[2] } else { a_score };
    tl[0] = if c_before_a { 2 } else { a_slot };
    ts[1] = if c_before_a {
        a_score
    } else if c_before_b {
        s[2]
    } else {
        b_score
    };
    tl[1] = if c_before_a {
        a_slot
    } else if c_before_b {
        2
    } else {
        b_slot
    };
    ts[2] = if c_before_a || c_before_b { b_score } else { s[2] };
    tl[2] = if c_before_a || c_before_b { b_slot } else { 2 };

    // --- single pass over the remaining slots ---
    for i in 3..16 {
        let v = s[i];
        let idx = i as u16;
        let enters = v > ts[2];
        let before0 = v > ts[0];
        let before1 = v > ts[1];

        let n0s = if enters && before0 { v } else { ts[0] };
        let n0l = if enters && before0 { idx } else { tl[0] };
        let n1s = if enters {
            if before0 {
                ts[0]
            } else if before1 {
                v
            } else {
                ts[1]
            }
        } else {
            ts[1]
        };
        let n1l = if enters {
            if before0 {
                tl[0]
            } else if before1 {
                idx
            } else {
                tl[1]
            }
        } else {
            tl[1]
        };
        let n2s = if enters {
            if before0 || before1 {
                ts[1]
            } else {
                v
            }
        } else {
            ts[2]
        };
        let n2l = if enters {
            if before0 || before1 {
                tl[1]
            } else {
                idx
            }
        } else {
            tl[2]
        };

        ts[0] = n0s;
        tl[0] = n0l;
        ts[1] = n1s;
        tl[1] = n1l;
        ts[2] = n2s;
        tl[2] = n2l;
    }

    (tl[0], ts[0], tl[1], ts[1], tl[2], ts[2])
}

/// Transcription of the CANDIDATE `reveal_top3_v3`.
///
/// Keeps the original's fully-parallel two-layer shape (depth 76 unchanged) but evaluates
/// only the UPPER TRIANGLE of the comparison matrix: one strict-greater bit per unordered
/// pair, C(16,2) = 120 comparisons instead of 256. Both directions of the comparator are
/// recovered from that single bit via the negation identity
///     j < i  =>  beats(j,i) = s[j] >= s[i] = 1 - G[j][i]
///     j > i  =>  beats(j,i) = s[j] >  s[i] =     G[i][j]
/// which also removes the `==` half of the original comparator. Selection stage is
/// byte-for-byte identical to `old`.
///
/// This is the candidate that matters for adoption: 603,016,496 ACU vs the original's
/// 702,629,424 (-14.2%), at identical network depth.
pub fn v3(raw: [u8; 16], participant_count: u8) -> Out {
    // Mask inactive slots to 0. Identical to `old`.
    let mut s = [0u8; 16];
    for i in 0..16 {
        let active = (i as u8) < participant_count;
        s[i] = if active { raw[i] } else { 0u8 };
    }

    // One parallel comparison layer: upper triangle only (120 comparisons).
    let mut g = [0u16; 256];
    for a in 0..16 {
        for b in 0..16 {
            if a < b {
                g[a * 16 + b] = if s[b] > s[a] { 1u16 } else { 0u16 };
            }
        }
    }

    // Rank by summation: purely local, adds no depth.
    let mut rank = [0u16; 16];
    for i in 0..16 {
        let mut r: u16 = 0;
        for j in 0..16 {
            if j < i {
                r += 1u16 - g[j * 16 + i];
            } else if j > i {
                r += g[i * 16 + j];
            }
        }
        rank[i] = r;
    }

    // Selection: unchanged from `old`.
    let mut top_slot = [0u16; 3];
    let mut top_score = [0u8; 3];
    for k in 0..3 {
        let mut found_slot: u16 = 0;
        let mut found_score: u8 = 0;
        for i in 0..16 {
            let is_k = rank[i] == (k as u16);
            found_slot = if is_k { i as u16 } else { found_slot };
            found_score = if is_k { s[i] } else { found_score };
        }
        top_slot[k] = found_slot;
        top_score[k] = found_score;
    }

    (
        top_slot[0],
        top_score[0],
        top_slot[1],
        top_score[1],
        top_slot[2],
        top_score[2],
    )
}

/// Independent oracle: sort all 16 masked slots by (score DESC, slot ASC) and take three.
///
/// Deliberately written a THIRD way — not derived from either circuit — so a shared
/// misreading of the spec cannot make `old` and `new` agree on a wrong answer. If both
/// transcriptions matched each other but the tie-break rule had been misunderstood, this
/// catches it.
pub fn oracle(raw: [u8; 16], participant_count: u8) -> Out {
    let mut v: Vec<(u8, u16)> = (0..16)
        .map(|i| {
            let active = (i as u8) < participant_count;
            (if active { raw[i as usize] } else { 0u8 }, i as u16)
        })
        .collect();
    // Descending by score; ascending by slot on ties.
    v.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    (v[0].1, v[0].0, v[1].1, v[1].0, v[2].1, v[2].0)
}

/// Deterministic xorshift64* — no dev-dependency, fully reproducible seeds.
pub struct Rng(pub u64);
impl Rng {
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    /// Uniform in `0..=max`.
    pub fn below(&mut self, max: u8) -> u8 {
        (self.next_u64() % (max as u64 + 1)) as u8
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Assert ALL FOUR implementations agree; on failure print the exact input and every
    /// output. Never weakened — a mismatch is a hard stop.
    fn check(raw: [u8; 16], pc: u8, label: &str) {
        let o = old(raw, pc);
        let n = new(raw, pc);
        let t = v3(raw, pc);
        let r = oracle(raw, pc);
        if o != n || o != t || o != r {
            panic!(
                "MISMATCH [{label}]\n  input scores      = {raw:?}\n  participant_count = {pc}\n\
                 \n  old    (live)     = {o:?}\n  new    (v2)       = {n:?}\n  v3   (candidate)  = {t:?}\n  oracle (sort)     = {r:?}\n\
                 \n  old vs new    : {}\n  old vs v3     : {}\n  old vs oracle : {}",
                if o == n { "AGREE" } else { "DIFFER" },
                if o == t { "AGREE" } else { "DIFFER" },
                if o == r { "AGREE" } else { "DIFFER" },
            );
        }
    }

    /// Every 16-slot array over {0,1}, against every participant_count 1..=16.
    /// 2^16 * 16 = 1,048,576 cases — exhaustive over the domain where ties are densest,
    /// which is exactly where a tie-break bug would hide.
    #[test]
    fn exhaustive_binary_scores() {
        for bits in 0u32..=0xFFFF {
            let mut raw = [0u8; 16];
            for i in 0..16 {
                raw[i] = ((bits >> i) & 1) as u8;
            }
            for pc in 1..=16u8 {
                check(raw, pc, "exhaustive_binary");
            }
        }
    }

    /// Exhaustive over {0,1,2} in the first 8 slots (3^8 = 6561), rest zero, all pc.
    /// Adds three-way ordering on top of the binary sweep.
    #[test]
    fn exhaustive_ternary_prefix() {
        let mut digits = [0u8; 8];
        for n in 0..6561u32 {
            let mut x = n;
            for d in digits.iter_mut() {
                *d = (x % 3) as u8;
                x /= 3;
            }
            let mut raw = [0u8; 16];
            raw[..8].copy_from_slice(&digits);
            for pc in 1..=16u8 {
                check(raw, pc, "exhaustive_ternary");
            }
        }
    }

    /// Randomized sweeps across several score domains. Narrow domains manufacture ties
    /// (the interesting case); the full 0..=255 domain covers realistic scores, which
    /// score_entry_v2 caps at 100.
    #[test]
    fn randomized_domains() {
        for &(max, iters, seed) in &[
            (1u8, 200_000u32, 0xA1u64),
            (3, 300_000, 0xB2),
            (5, 300_000, 0xC3),
            (100, 200_000, 0xD4),
            (255, 200_000, 0xE5),
        ] {
            let mut rng = Rng(seed);
            for _ in 0..iters {
                let mut raw = [0u8; 16];
                for slot in raw.iter_mut() {
                    *slot = rng.below(max);
                }
                let pc = 1 + (rng.next_u64() % 16) as u8;
                check(raw, pc, &format!("random(max={max})"));
            }
        }
    }

    /// Named structural edge cases.
    #[test]
    fn structured_edge_cases() {
        let mut cases: Vec<(&str, [u8; 16])> = Vec::new();

        cases.push(("all zero", [0; 16]));
        cases.push(("all same nonzero", [7; 16]));
        cases.push(("all 255", [255; 16]));

        let mut asc = [0u8; 16];
        for i in 0..16 {
            asc[i] = i as u8;
        }
        cases.push(("ascending (reverse-sorted by rank)", asc));

        let mut desc = [0u8; 16];
        for i in 0..16 {
            desc[i] = (15 - i) as u8;
        }
        cases.push(("descending (already sorted)", desc));

        // Ties exactly at the top-3 boundary: ranks 2 and 3 share a score.
        cases.push((
            "tie at 3rd/4th boundary",
            [9, 8, 7, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        ));
        cases.push((
            "four-way tie for 1st",
            [9, 9, 9, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        ));
        cases.push((
            "top-3 all tied, 4th lower",
            [5, 5, 5, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        ));
        cases.push((
            "winner in last slot",
            [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 200],
        ));
        cases.push((
            "top three in the last three slots",
            [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 200, 201, 202],
        ));
        cases.push((
            "seed slots are the losers",
            [0, 0, 0, 10, 11, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        ));
        cases.push((
            "only slot 0 nonzero",
            [42, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        ));
        // Zero is a REAL score, not a sentinel: a genuine 0 must be able to place.
        cases.push((
            "real zeros compete with padding zeros",
            [0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        ));
        cases.push((
            "equal scores straddling the mask boundary",
            [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
        ));

        for (label, raw) in cases {
            for pc in 1..=16u8 {
                check(raw, pc, label);
            }
        }
    }

    /// v3's correctness rests on ONE algebraic identity: for j != i the comparator is the
    /// negation of its transpose, so a single strict-greater bit per unordered pair
    /// determines both directions. The identity is only load-bearing when scores are EQUAL
    /// (that is where `>=` vs `>` diverges and where the lower-index tie-break decides).
    /// This test therefore hammers ties specifically: every tie multiplicity from 2-way up
    /// to 16-way, at every starting slot, straddling every rank boundary.
    #[test]
    fn ties_at_every_boundary_and_multiplicity() {
        // Exhaustive over "a block of `m` equal HIGH scores starting at slot `start`,
        // everything else LOW" — for every m and start, and every participant_count.
        for m in 1..=16usize {
            for start in 0..=(16 - m) {
                for &(lo, hi) in &[(0u8, 1u8), (5, 9), (0, 255), (254, 255)] {
                    let mut raw = [lo; 16];
                    for slot in raw.iter_mut().skip(start).take(m) {
                        *slot = hi;
                    }
                    for pc in 1..=16u8 {
                        check(raw, pc, "tie-block");
                    }
                }
            }
        }

        // Two tie groups whose boundary falls exactly across ranks 3/4 — the case where a
        // wrong tie-break silently swaps who is 3rd and who is 4th (invisible on-chain,
        // since only the top 3 are revealed).
        for hi_count in 1..=6usize {
            for tie_count in 2..=6usize {
                let mut raw = [0u8; 16];
                for (i, slot) in raw.iter_mut().enumerate() {
                    *slot = if i < hi_count {
                        200
                    } else if i < hi_count + tie_count {
                        100 // the tied block straddling the cut
                    } else {
                        1
                    };
                }
                for pc in 1..=16u8 {
                    check(raw, pc, "tie-straddling-3rd/4th");
                }
            }
        }

        // Interleaved ties: equal scores at non-adjacent slots, so the tie-break must pick
        // by index across gaps rather than within a contiguous run.
        for step in 2..=5usize {
            for &val in &[7u8, 128, 255] {
                let mut raw = [0u8; 16];
                for i in (0..16).step_by(step) {
                    raw[i] = val;
                }
                for pc in 1..=16u8 {
                    check(raw, pc, "interleaved-ties");
                }
            }
        }

        // Every pair of slots tied at the top with the rest strictly lower: makes the
        // index tie-break decisive for ranks 1 and 2 specifically.
        for a in 0..16usize {
            for b in (a + 1)..16usize {
                let mut raw = [3u8; 16];
                raw[a] = 9;
                raw[b] = 9;
                for pc in 1..=16u8 {
                    check(raw, pc, "top-pair-tie");
                }
            }
        }
    }

    /// The participant_count edge values called out for v3: 1, 2, 15, 16 (plus their
    /// neighbours) against dense-tie score vectors, where masking interacts with ranking.
    #[test]
    fn participant_count_edges() {
        let mut rng = Rng(0xC0FFEE);
        for &pc in &[1u8, 2, 3, 14, 15, 16] {
            for _ in 0..40_000 {
                let mut raw = [0u8; 16];
                for slot in raw.iter_mut() {
                    *slot = rng.below(2); // domain {0,1,2}: maximal tie density
                }
                check(raw, pc, "pc-edge");
            }
            // deterministic companions at the same pc
            for &v in &[0u8, 1, 255] {
                check([v; 16], pc, "pc-edge-uniform");
            }
            let mut asc = [0u8; 16];
            for i in 0..16 {
                asc[i] = i as u8;
            }
            check(asc, pc, "pc-edge-ascending");
            let mut desc = [0u8; 16];
            for i in 0..16 {
                desc[i] = (15 - i) as u8;
            }
            check(desc, pc, "pc-edge-descending");
        }
    }

    /// Direct assertion of the identity v3 relies on, independent of the top-3 output:
    /// the rank vector computed from the upper triangle must equal the rank vector the
    /// original computes from all 16x16 ordered pairs. If this ever fails, v3's premise is
    /// broken even if the top-3 happens to coincide.
    #[test]
    fn negation_identity_reproduces_original_ranks() {
        fn ranks_original(s: &[u8; 16]) -> [u16; 16] {
            let mut rank = [0u16; 16];
            for i in 0..16 {
                let mut r = 0u16;
                for j in 0..16 {
                    if (s[j] > s[i]) || ((s[j] == s[i]) && (j < i)) {
                        r += 1;
                    }
                }
                rank[i] = r;
            }
            rank
        }
        fn ranks_upper_triangle(s: &[u8; 16]) -> [u16; 16] {
            let mut g = [0u16; 256];
            for a in 0..16 {
                for b in 0..16 {
                    if a < b {
                        g[a * 16 + b] = if s[b] > s[a] { 1 } else { 0 };
                    }
                }
            }
            let mut rank = [0u16; 16];
            for i in 0..16 {
                let mut r = 0u16;
                for j in 0..16 {
                    if j < i {
                        r += 1 - g[j * 16 + i];
                    } else if j > i {
                        r += g[i * 16 + j];
                    }
                }
                rank[i] = r;
            }
            rank
        }
        let mut rng = Rng(0x1DEA);
        let mut checked = 0u32;
        // dense-tie domains where the identity is load-bearing
        for &max in &[1u8, 2, 3, 255] {
            for _ in 0..150_000 {
                let mut raw = [0u8; 16];
                for slot in raw.iter_mut() {
                    *slot = rng.below(max);
                }
                for pc in [1u8, 5, 16] {
                    let mut s = [0u8; 16];
                    for i in 0..16 {
                        s[i] = if (i as u8) < pc { raw[i] } else { 0 };
                    }
                    let a = ranks_original(&s);
                    let b = ranks_upper_triangle(&s);
                    assert_eq!(a, b, "rank identity broken for {s:?} (pc={pc})");
                    checked += 1;
                }
            }
        }
        assert!(checked > 1_000_000);
    }

    /// participant_count = 0 is rejected on-chain (`queue_reveal_top3` requires 1..=16),
    /// so it can never reach the circuit. Pinned anyway: if it ever did, the two must
    /// still agree rather than diverge silently.
    #[test]
    fn participant_count_zero_still_agrees() {
        let mut rng = Rng(0xF00D);
        for _ in 0..20_000 {
            let mut raw = [0u8; 16];
            for slot in raw.iter_mut() {
                *slot = rng.below(255);
            }
            check(raw, 0, "pc=0");
        }
    }

    /// Guard the property the equivalence argument rests on: the total order is strict,
    /// so ranks are unique and "positions 0,1,2" is well defined. If a future edit made
    /// two slots share a rank, `old`'s selection loop would silently keep the last match.
    #[test]
    fn old_ranks_are_unique() {
        let mut rng = Rng(0x5EED);
        for _ in 0..100_000 {
            let mut raw = [0u8; 16];
            for slot in raw.iter_mut() {
                *slot = rng.below(3);
            }
            let pc = 1 + (rng.next_u64() % 16) as u8;

            let mut s = [0u8; 16];
            for i in 0..16 {
                s[i] = if (i as u8) < pc { raw[i] } else { 0u8 };
            }
            let mut rank = [0u16; 16];
            for i in 0..16 {
                let mut r = 0u16;
                for j in 0..16 {
                    if (s[j] > s[i]) || ((s[j] == s[i]) && (j < i)) {
                        r += 1;
                    }
                }
                rank[i] = r;
            }
            let mut seen = [false; 16];
            for &r in rank.iter() {
                assert!(
                    r < 16 && !seen[r as usize],
                    "rank collision at {r} for input {raw:?} pc={pc} ranks={rank:?}"
                );
                seen[r as usize] = true;
            }
        }
    }
}
