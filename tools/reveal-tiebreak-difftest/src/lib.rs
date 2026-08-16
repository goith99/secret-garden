//! Differential test: `reveal_top3_v5`'s rarity tiebreak vs `reveal_top3_v3`'s score-only ranking.
//!
//! WHAT THIS IS. Host transcriptions of the ranking half of both circuits, Arcis wrappers
//! stripped: `Enc<Mxe, u8>` becomes a plain `u8` and the secret comparisons become ordinary
//! ones. The comparator STRUCTURE is copied verbatim — the upper-triangle `g` matrix, the
//! `j < i` / `j > i` asymmetry that makes ties fall to the lower slot, and the rank-by-
//! summation. Only the compared quantity differs: v3 ranks on the raw score, v5 on the
//! composite key `score * 8 + rarity`.
//!
//! WHAT IT PROVES. That the tiebreak does what it claims (higher rarity wins an equal
//! score), that it never overrides the score itself, that it degenerates exactly to v3 when
//! rarity carries no information, and — the load-bearing one — that the ranking stays a
//! TOTAL ORDER so `rank` is always a permutation. It does not prove the Arcis compilation
//! is faithful, only that the algorithm is sound.
//!
//! Run: cargo test --release

pub const SLOTS: usize = 16;

/// v3 (current, deployed): rank on the raw score alone.
pub fn ranks_v3(s: &[u8; SLOTS], participant_count: u8) -> [u16; SLOTS] {
    let mut masked = [0u8; SLOTS];
    for i in 0..SLOTS {
        masked[i] = if (i as u8) < participant_count { s[i] } else { 0 };
    }
    rank_by(&masked.map(|x| x as u16))
}

/// v5: rank on the composite key `score * 8 + rarity`.
///
/// rarity 0 (unranked) is taken at face value and loses every rarity tiebreak — the NAIVE
/// rule, chosen deliberately over the alternatives. Padding slots get score 0 AND rarity 0.
pub fn ranks_v5(s: &[u8; SLOTS], r: &[u8; SLOTS], participant_count: u8) -> [u16; SLOTS] {
    let mut k = [0u16; SLOTS];
    for i in 0..SLOTS {
        let active = (i as u8) < participant_count;
        let score = if active { s[i] } else { 0 };
        let rar = if active { r[i] } else { 0 };
        k[i] = (score as u16) * 8 + rar as u16;
    }
    rank_by(&k)
}

/// The shared comparator, verbatim from the circuit: upper-triangle `g`, then rank by
/// summation with `j < i` counting a tie as a win (ties fall to the LOWER slot index).
fn rank_by(k: &[u16; SLOTS]) -> [u16; SLOTS] {
    let mut g = [0u16; SLOTS * SLOTS];
    for a in 0..SLOTS {
        for b in 0..SLOTS {
            if a < b {
                g[a * SLOTS + b] = if k[b] > k[a] { 1 } else { 0 };
            }
        }
    }
    let mut rank = [0u16; SLOTS];
    for i in 0..SLOTS {
        let mut c: u16 = 0;
        for j in 0..SLOTS {
            if j < i {
                c += 1 - g[j * SLOTS + i];
            } else if j > i {
                c += g[i * SLOTS + j];
            }
        }
        rank[i] = c;
    }
    rank
}

/// The REJECTED per-pair rule, kept only so a test can prove it is unsound and nobody
/// reintroduces it: "if either side is unranked, compare that pair on raw score only".
pub fn ranks_pairwise_neutral_REJECTED(
    s: &[u8; SLOTS],
    r: &[u8; SLOTS],
    participant_count: u8,
) -> [u16; SLOTS] {
    let n = participant_count as usize;
    let mut g = [0u16; SLOTS * SLOTS];
    for a in 0..SLOTS {
        for b in 0..SLOTS {
            if a < b {
                let (sa, sb) = (
                    if a < n { s[a] } else { 0 },
                    if b < n { s[b] } else { 0 },
                );
                let (ra, rb) = (
                    if a < n { r[a] } else { 0 },
                    if b < n { r[b] } else { 0 },
                );
                let neutral = ra == 0 || rb == 0;
                let ka = if neutral { sa as u16 } else { sa as u16 * 8 + ra as u16 };
                let kb = if neutral { sb as u16 } else { sb as u16 * 8 + rb as u16 };
                g[a * SLOTS + b] = if kb > ka { 1 } else { 0 };
            }
        }
    }
    let mut rank = [0u16; SLOTS];
    for i in 0..SLOTS {
        let mut c: u16 = 0;
        for j in 0..SLOTS {
            if j < i {
                c += 1 - g[j * SLOTS + i];
            } else if j > i {
                c += g[i * SLOTS + j];
            }
        }
        rank[i] = c;
    }
    rank
}

/// Winner slot = the one with rank 0.
pub fn winner(rank: &[u16; SLOTS]) -> Option<usize> {
    (0..SLOTS).find(|&i| rank[i] == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    fn pad(vals: &[u8]) -> [u8; SLOTS] {
        let mut a = [0u8; SLOTS];
        a[..vals.len()].copy_from_slice(vals);
        a
    }

    /// THE POINT OF THE FEATURE: equal scores, higher rarity takes the podium.
    #[test]
    fn higher_rarity_wins_a_clean_score_tie() {
        // slot 0 is Common(1), slot 1 is Legendary(5) — identical score.
        let s = pad(&[70, 70, 40]);
        let r = pad(&[1, 5, 3]);
        let v5 = ranks_v5(&s, &r, 3);
        assert_eq!(winner(&v5), Some(1), "higher rarity must win the tie");
        // and v3 (score only) would have given it to the LOWER SLOT instead:
        let v3 = ranks_v3(&s, 3);
        assert_eq!(winner(&v3), Some(0), "v3 baseline: tie falls to lower slot");
    }

    /// Equal score AND equal rarity: nothing left to decide it but slot order, exactly as before.
    #[test]
    fn equal_rarity_falls_through_to_slot_order() {
        let s = pad(&[70, 70, 70]);
        let r = pad(&[4, 4, 4]);
        let v5 = ranks_v5(&s, &r, 3);
        assert_eq!(winner(&v5), Some(0), "full tie must fall to the lowest slot");
        assert_eq!(ranks_v3(&s, 3), v5, "with uniform rarity, v5 must equal v3 exactly");
    }

    /// NAIVE rule, stated as a test so the trade-off is explicit: unranked loses.
    #[test]
    fn unranked_rarity_zero_loses_a_tie_to_any_ranked_flower() {
        // slot 0 unranked (legacy hybrid), slot 1 Common(1) — same score.
        let s = pad(&[52, 52]);
        let r = pad(&[0, 1]);
        assert_eq!(winner(&ranks_v5(&s, &r, 2)), Some(1), "rarity 0 must lose to rarity 1");
        // Two unranked flowers tie with each other and fall to slot order.
        let r2 = pad(&[0, 0]);
        assert_eq!(winner(&ranks_v5(&s, &r2, 2)), Some(0));
    }

    /// Rarity must NEVER override the score. 8 * (score gap of 1) = 8 > max rarity gap 5.
    #[test]
    fn score_always_dominates_rarity() {
        let mut rng = Rng(0xA11CE);
        for _ in 0..300_000 {
            let n = 2 + rng.below(15) as usize;
            let mut s = [0u8; SLOTS];
            let mut r = [0u8; SLOTS];
            for i in 0..n {
                s[i] = rng.below(101) as u8;
                r[i] = rng.below(6) as u8;
            }
            let rank = ranks_v5(&s, &r, n as u8);
            for i in 0..n {
                for j in 0..n {
                    if s[i] > s[j] {
                        assert!(
                            rank[i] < rank[j],
                            "score {} lost to score {} (rarities {} vs {})",
                            s[i], s[j], r[i], r[j]
                        );
                    }
                }
            }
        }
    }

    /// THE LOAD-BEARING PROPERTY. A per-slot key induces a total order, so `rank` must
    /// always be a permutation of 0..16 — no cycles, no collisions, always exactly one
    /// slot at rank 0. If this fails the podium is undefined.
    #[test]
    fn ranking_is_always_a_permutation_no_cycles() {
        let mut rng = Rng(0xBEEF);
        for _ in 0..300_000 {
            let n = 1 + rng.below(16) as usize;
            let mut s = [0u8; SLOTS];
            let mut r = [0u8; SLOTS];
            for i in 0..n {
                // dense ties on purpose: few distinct scores is the real-world case
                s[i] = [0u8, 17, 35, 52, 70][rng.below(5) as usize];
                r[i] = rng.below(6) as u8;
            }
            let rank = ranks_v5(&s, &r, n as u8);
            let mut seen = [false; SLOTS];
            for &v in rank.iter() {
                let v = v as usize;
                assert!(v < SLOTS && !seen[v], "rank collision: {rank:?}");
                seen[v] = true;
            }
            assert!(winner(&rank).is_some(), "no slot holds rank 0");
        }
    }

    /// Backwards compatibility: if every entry carries the same rarity, v5 reproduces v3.
    #[test]
    fn v5_degenerates_to_v3_when_rarity_is_uniform() {
        let mut rng = Rng(0xD00D);
        for _ in 0..200_000 {
            let n = 1 + rng.below(16) as usize;
            let mut s = [0u8; SLOTS];
            for i in 0..n {
                s[i] = rng.below(101) as u8;
            }
            for uniform in 0..=5u8 {
                let r = [uniform; SLOTS];
                assert_eq!(
                    ranks_v5(&s, &r, n as u8),
                    ranks_v3(&s, n as u8),
                    "uniform rarity {uniform} must not change the ranking"
                );
            }
        }
    }

    /// REGRESSION PIN. The per-pair "neutral" rule was proposed and rejected because it is
    /// non-transitive. This reproduces the exact counterexample and asserts it really does
    /// break, so the rule cannot quietly come back.
    #[test]
    fn rejected_pairwise_neutral_rule_really_is_unsound() {
        // three entries, all score 50, rarities 1 / 0 / 5 at slots 0 / 1 / 2
        let s = pad(&[50, 50, 50]);
        let r = pad(&[1, 0, 5]);
        let bad = ranks_pairwise_neutral_REJECTED(&s, &r, 3);
        // slots 0,1,2 all end up on the same rank -> no rank 0 among them
        assert_eq!(bad[0], bad[1], "expected the documented rank collision");
        assert_eq!(bad[1], bad[2], "expected the documented rank collision");
        // the shipped rule handles the same input cleanly
        let good = ranks_v5(&s, &r, 3);
        assert_eq!(winner(&good), Some(2), "Legendary should take a 3-way score tie");
        let mut seen = [false; SLOTS];
        for &v in good.iter() {
            assert!(!seen[v as usize]);
            seen[v as usize] = true;
        }
    }
}
