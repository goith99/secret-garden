/**
 * Bred-hybrid rarity — packed-mask encoding, pure-logic verification.
 *
 * Rarity is rolled inside the `breed` MPC circuit and PACKED into the existing revealed u32
 * mask (bits 19-21), keeping the proven 2-tuple `(Enc<Mxe,Genome>, u32)` output. The callback
 * unpacks rarity into `FlowerRecord.rarity` and stores a rarity-STRIPPED (class-only) mask, so
 * the frontend's petal/color/leaf/stem decoder is untouched. The MPC roll can't run under
 * bankrun, but everything else is deterministic and verified exhaustively here.
 *
 * Bits 19-21 (not the earlier 27-29): the live Arcium output path truncates a revealed u32 at
 * ~27 bits, so a rarity at 27-29 read back as 0 on-chain — 19-21 stays below that cliff.
 *
 * The constants/mapping below MUST stay in sync with:
 *   - circuit  (encrypted-ixs/src/lib.rs `breed`): u8 draw + `(r+256-b)/256` carry tiers, `+ rarity * 2^19` packing
 *   - callback (programs/.../lib.rs `breed_callback`): `(mask>>19)&0x7`, `mask & 0xFFC7FFFF`
 *   - frontend (secret-garden-frontend/src/visuals/*.ts): class = `(mask>>8k)&0xff % 5`
 */
import { expect } from "chai";

// --- rarity roll (attempt 4): single u8 draw + carry-extraction tiers, MUST match the circuit ---
// tier boundaries b over the 256 uniform u8 outcomes; `(r + 256 - b) / 256` == [r >= b].
const B_UNCOMMON = 115, B_RARE = 192, B_EPIC = 230, B_LEGENDARY = 251;
const N = 256; // uniform u8 outcomes

/** Mirrors the circuit EXACTLY: 1 + Σ floor((r + 256 - b) / 256). */
function tierOf(r: number): number {
  return 1
    + Math.floor((r + (256 - B_UNCOMMON)) / 256)
    + Math.floor((r + (256 - B_RARE)) / 256)
    + Math.floor((r + (256 - B_EPIC)) / 256)
    + Math.floor((r + (256 - B_LEGENDARY)) / 256);
}

// --- packed-mask helpers, MUST match circuit(pack) / callback(unpack,strip) / frontend(class) ---
const RARITY_SHIFT = 19; // rarity occupies bits 19-21 (below the ~27-bit live-reveal cliff)
/** circuit: petal + color*256 + leaf*65536 + stem*16777216 + rarity*2^19 */
function packMask(petal: number, color: number, leaf: number, stem: number, rarity: number): number {
  return (petal + color * 256 + leaf * 65_536 + stem * 16_777_216 + rarity * 2 ** RARITY_SHIFT) >>> 0;
}
/** callback: (mask >> 19) & 0x07 */
const unpackRarity = (mask: number): number => (mask >>> RARITY_SHIFT) & 0x07;
/** callback: mask & 0xFFC7FFFF  (clear bits 19-21) */
const stripRarity = (mask: number): number => (mask & 0xffc7_ffff) >>> 0;
/** frontend: class k = ((mask >> 8k) & 0xff) % 5 */
const frontendClass = (mask: number, k: number): number => ((mask >>> (8 * k)) & 0xff) % 5;

const EXPECTED_PCT: Record<number, number> = { 1: 45, 2: 30, 3: 15, 4: 8, 5: 2 };

describe("bred-hybrid rarity — distribution (u8 carry-extraction)", () => {
  it("realizes 115/77/38/21/5 over ALL 256 u8 draws (≈ Distribution B 45/30/15/8/2)", () => {
    const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (let r = 0; r < N; r++) counts[tierOf(r)] += 1;
    // Exact integer counts the u8 boundaries produce (best rounding of 45/30/15/8/2 * 256).
    expect(counts).to.deep.equal({ 1: 115, 2: 77, 3: 38, 4: 21, 5: 5 });
    expect(counts[1] + counts[2] + counts[3] + counts[4] + counts[5]).to.equal(N);
    // Each tier is within 0.4pp of the target — the closest a single u8 draw can get.
    for (const t of [1, 2, 3, 4, 5]) {
      expect((counts[t] / N) * 100, `tier ${t} share`).to.be.closeTo(EXPECTED_PCT[t], 0.4);
    }
  });

  it("each tier boundary maps to the correct adjacent tiers", () => {
    expect(tierOf(0)).to.equal(1);
    expect(tierOf(B_UNCOMMON - 1)).to.equal(1);
    expect(tierOf(B_UNCOMMON)).to.equal(2);
    expect(tierOf(B_RARE - 1)).to.equal(2);
    expect(tierOf(B_RARE)).to.equal(3);
    expect(tierOf(B_EPIC - 1)).to.equal(3);
    expect(tierOf(B_EPIC)).to.equal(4);
    expect(tierOf(B_LEGENDARY - 1)).to.equal(4);
    expect(tierOf(B_LEGENDARY)).to.equal(5);
    expect(tierOf(N - 1)).to.equal(5);
  });

  it("only ever produces the on-chain rarity range 1..=5 (never the unranked 0)", () => {
    for (let r = 0; r < N; r++) expect(tierOf(r), `r=${r}`).to.be.within(1, 5);
  });
});

describe("bred-hybrid rarity — packed-mask encode/decode", () => {
  it("callback unpacks the exact rarity for every class+rarity combination (bits 19-21)", () => {
    for (let petal = 0; petal <= 4; petal++)
      for (let color = 0; color <= 4; color++)
        for (let leaf = 0; leaf <= 4; leaf++)
          for (let stem = 0; stem <= 4; stem++)
            for (let rarity = 1; rarity <= 5; rarity++) {
              const mask = packMask(petal, color, leaf, stem, rarity);
              expect(unpackRarity(mask), `rarity round-trip (p${petal}c${color}l${leaf}s${stem}r${rarity})`).to.equal(rarity);
              // THE POINT OF THE FIX: the whole packed mask stays below bit 27, so nothing
              // rides the ~27-bit live-reveal cliff that dropped the old bits-27-29 rarity.
              expect(mask >>> 27, "whole mask stays below bit 27 (survives live reveal)").to.equal(0);
            }
  });

  it("the rarity-stripped mask decodes to the ORIGINAL classes (frontend decoder unaffected)", () => {
    for (let petal = 0; petal <= 4; petal++)
      for (let color = 0; color <= 4; color++)
        for (let leaf = 0; leaf <= 4; leaf++)
          for (let stem = 0; stem <= 4; stem++)
            for (let rarity = 1; rarity <= 5; rarity++) {
              const clean = stripRarity(packMask(petal, color, leaf, stem, rarity));
              expect(frontendClass(clean, 0), "petal").to.equal(petal);
              expect(frontendClass(clean, 1), "color").to.equal(color);
              expect(frontendClass(clean, 2), "leaf").to.equal(leaf);
              expect(frontendClass(clean, 3), "stem").to.equal(stem);
              // The stripped mask is byte-identical to a pre-rarity mask (bits 19-21 cleared).
              expect((clean >>> 19) & 0x07, "stripped mask has no rarity bits (19-21)").to.equal(0);
            }
  });

  it("rarity bits live ONLY in the leaf byte's high bits (19-21): petal/color/stem unaffected even BEFORE stripping", () => {
    // Layout is disjoint — rarity (bits 19-21) sits above leaf (16-18) and below stem (24-26),
    // so it can only ever perturb the LEAF byte, which the callback strips before storing.
    const mask = packMask(4, 4, 4, 4, 5); // all classes max, rarity max
    expect(frontendClass(mask, 0)).to.equal(4); // petal (byte 0) — unaffected
    expect(frontendClass(mask, 1)).to.equal(4); // color (byte 1) — unaffected
    expect(frontendClass(mask, 3)).to.equal(4); // stem  (byte 3) — unaffected (rarity is below it)
    // leaf's raw byte carries rarity in its high bits (why the callback strips it before store):
    expect(((mask >>> 16) & 0xff)).to.not.equal(4); // raw byte 2 != leaf until stripped
    expect(frontendClass(stripRarity(mask), 2)).to.equal(4); // leaf correct after strip
    expect(unpackRarity(mask)).to.equal(5);
    expect(mask >>> 27, "even the maxed mask stays below bit 27").to.equal(0);
  });
});
