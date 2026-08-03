/**
 * Breed mutation math — pure-logic verification of the divide-by-2 fix.
 *
 * The `breed` circuit's `pick()` closure (encrypted-ixs/src/lib.rs) has a ~1/8 mutation branch
 * that emits a two-parent AVERAGE instead of the dominant-parent copy. It previously divided
 * the two-parent sum by 3 (with mutate_roll folded into the numerator), which pulled mutated
 * genes ~29% BELOW the true parent average (mean ~90 instead of ~127.5) and silently made every
 * `>=`-threshold trait harder to satisfy. The fix is a true average: `(ga + gb) / 2`.
 *
 * The MPC branch can't run under bankrun, but the math is deterministic, so this mirrors the
 * exact circuit formula and asserts the corrected statistical behaviour. MUST stay in sync with:
 *   - circuit: `let mutated = ((ga as u16 + gb as u16) / 2) as u8;`  (the mutation branch)
 *   - the TRAIT_TABLE thresholds in `score_entry` / `private_hint` (>= checks below).
 */
import { expect } from "chai";

/** Circuit's fixed mutation formula: floor((ga + gb) / 2), u8. */
const mutated = (ga: number, gb: number): number => Math.floor((ga + gb) / 2);

describe("breed mutation math — divide-by-2 fix", () => {
  it("mutated equals a TRUE two-parent average (never truncates, never overflows u8)", () => {
    for (let ga = 0; ga <= 255; ga++)
      for (let gb = 0; gb <= 255; gb++) {
        const m = mutated(ga, gb);
        expect(m, `(${ga},${gb})`).to.equal(Math.floor((ga + gb) / 2));
        expect(m, "within u8").to.be.within(0, 255);
        // never more than 0.5 below the real average (integer floor only)
        expect((ga + gb) / 2 - m).to.be.within(0, 0.5);
      }
  });

  it("mean over all parent pairs is the true parent mean ~127.5 (was ~89.83 under /3)", () => {
    let sum = 0, n = 0, skew = 0;
    for (let ga = 0; ga <= 255; ga++)
      for (let gb = 0; gb <= 255; gb++) {
        sum += mutated(ga, gb);
        skew += (ga + gb) / 2 - mutated(ga, gb);
        n++;
      }
    const mean = sum / n;
    expect(mean, "mutated mean").to.be.closeTo(127.5, 0.5); // 127.25 (0.25 floor bias)
    expect(skew / n, "residual downward skew").to.be.closeTo(0.25, 0.01); // vs 37.67 under /3
  });

  it("equal-parent cases return that gene value exactly (v,v -> v), not ~2/3 of it", () => {
    for (const v of [0, 50, 100, 128, 150, 180, 200, 240, 255]) {
      expect(mutated(v, v), `avg(${v},${v})`).to.equal(v); // /3 gave ~0.67*v
    }
  });

  it("no systematic downward skew: E[mutated] is NOT below ~0.71x the average (the /3 signature)", () => {
    // Under /3 the ratio mutated/avg was ~0.705; the fix must be ~1.0.
    let sumMut = 0, sumAvg = 0;
    for (let ga = 0; ga <= 255; ga++)
      for (let gb = 0; gb <= 255; gb++) {
        sumMut += mutated(ga, gb);
        sumAvg += (ga + gb) / 2;
      }
    expect(sumMut / sumAvg, "mutated/avg ratio").to.be.closeTo(1.0, 0.01); // was 0.705
  });
});

describe("breed mutation — threshold-trait clear-rates restored", () => {
  // TRAIT_TABLE >= thresholds for the 7 pick()-based genes affected by the mutation branch.
  const THRESHOLDS: Array<[string, number]> = [
    ["Crimson (color>=180)", 180], ["Full Bloom (petal>=150)", 150],
    ["Broadleaf (leaf>=128)", 128], ["Tall (stem>=160)", 160],
    ["Fragrant (aroma>=150)", 150], ["Hardy (climate>=140)", 140],
    ["Stable (stability>=150)", 150],
  ];
  // Overall P(trait satisfied) = 7/8 * P(inherited single-parent >= T) + 1/8 * P(mutated >= T),
  // over uniform parents 0-255. The fix must restore each toward the pre-bug (/2) baseline.
  const clearRate = (T: number, mut: (a: number, b: number) => number): number => {
    let inhHits = 0, mutHits = 0, pairs = 0;
    for (let ga = 0; ga <= 255; ga++)
      for (let gb = 0; gb <= 255; gb++) {
        pairs++;
        if (mut(ga, gb) >= T) mutHits++;
      }
    inhHits = (256 - T) / 256; // P(uniform single parent >= T)
    return (7 / 8) * inhHits + (1 / 8) * (mutHits / pairs);
  };
  const clearRateOld3 = (T: number): number => {
    let mutHits = 0, pairs = 0;
    for (let ga = 0; ga <= 255; ga++)
      for (let gb = 0; gb <= 255; gb++)
        for (let r = 0; r < 32; r++) { pairs++; if (Math.floor((ga + gb + r) / 3) >= T) mutHits++; }
    return (7 / 8) * ((256 - T) / 256) + (1 / 8) * (mutHits / pairs);
  };

  for (const [name, T] of THRESHOLDS) {
    it(`${name}: fix raises the clear-rate above the /3 value (skew removed)`, () => {
      const fixed = clearRate(T, mutated);
      const old3 = clearRateOld3(T);
      expect(fixed, "fixed > old /3").to.be.greaterThan(old3);
      // The recovered gap is the ~10% relative that /3 was removing (each trait 2.5-5pp).
      expect(fixed - old3, "recovered gap").to.be.greaterThan(0.02);
    });
  }
});
