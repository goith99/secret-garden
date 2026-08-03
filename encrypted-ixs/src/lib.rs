use arcis::*;

/// Secret Garden Protocol — encrypted breeding circuit (Stage 3A).
///
/// The MPC nodes decrypt both parents' genomes (or derive a starter parent's genome
/// from its public species id), combine them under the player's private environment
/// choices with genuine MPC randomness, and return the offspring genome re-encrypted
/// to the MXE so it can be stored on-chain without ever being revealed in plaintext.
#[encrypted]
mod circuits {
    use arcis::*;

    /// Packed genome: ten logical byte-fields. Each `u8` is encrypted as one BN254
    /// field element, so `Enc<Mxe, Genome>` serializes to 10 ciphertexts of 32 bytes
    /// each (320 bytes) plus a 16-byte nonce. (The 0..=255 logical range uses only the
    /// low byte of each 255-bit field element — that headroom is the "padding" Arcis's
    /// field-element encoding introduces; it is not packed away here.)
    pub struct Genome {
        color_gene: u8,
        petal_gene: u8,
        leaf_gene: u8,
        stem_gene: u8,
        aroma_gene: u8,
        climate_gene: u8,
        recessive_mask: u8,
        mutation_affinity: u8,
        stability: u8,
        reserved: u8,
    }

    /// Player's private cultivation environment. Combined into one `Enc<Shared, _>` so a
    /// single nonce/pubkey covers all three values (three separate `Enc<Shared, u8>`
    /// inputs would each need their own nonce, inviting reuse bugs).
    pub struct Environment {
        light: u8,
        water: u8,
        soil: u8,
    }

    /// Parent-kind tag (matches `FlowerRecord.genome_status` on-chain).
    const KIND_STARTER: u8 = 0;

    #[instruction]
    pub fn breed(
        // Parent A: `kind`/`species` are public; `genome` is the parent's stored
        // ciphertext (zeroed and ignored when the parent is a Starter).
        parent_a_kind: u8,
        parent_a_species: u8,
        parent_a_genome: Enc<Mxe, Genome>,
        // Parent B: same shape.
        parent_b_kind: u8,
        parent_b_species: u8,
        parent_b_genome: Enc<Mxe, Genome>,
        // Player's private environment choices.
        env: Enc<Shared, Environment>,
    ) -> (Enc<Mxe, Genome>, u32) {
        // Deterministic, documented mapping from a public starter species id to its
        // effective genome. Species ids 0..=5 mirror the Stage 1 SPECIES table.
        let starter = |species: u8| -> Genome {
            match species {
                // 0 — Lunar Silkweave: luminous, silvery, very stable.
                0 => Genome {
                    color_gene: 200,
                    petal_gene: 130,
                    leaf_gene: 90,
                    stem_gene: 100,
                    aroma_gene: 60,
                    climate_gene: 170,
                    recessive_mask: 20,
                    mutation_affinity: 50,
                    stability: 210,
                    reserved: 0,
                },
                // 1 — Specter Orchid: pale, showy petals, more volatile.
                1 => Genome {
                    color_gene: 60,
                    petal_gene: 200,
                    leaf_gene: 70,
                    stem_gene: 80,
                    aroma_gene: 90,
                    climate_gene: 120,
                    recessive_mask: 40,
                    mutation_affinity: 90,
                    stability: 150,
                    reserved: 0,
                },
                // 2 — Heart's Echo: strongly scented, balanced.
                2 => Genome {
                    color_gene: 150,
                    petal_gene: 180,
                    leaf_gene: 110,
                    stem_gene: 120,
                    aroma_gene: 220,
                    climate_gene: 100,
                    recessive_mask: 30,
                    mutation_affinity: 60,
                    stability: 180,
                    reserved: 0,
                },
                // 3 — Dawnlotus Prime: premium across the board, very stable.
                3 => Genome {
                    color_gene: 220,
                    petal_gene: 210,
                    leaf_gene: 160,
                    stem_gene: 150,
                    aroma_gene: 140,
                    climate_gene: 200,
                    recessive_mask: 10,
                    mutation_affinity: 70,
                    stability: 240,
                    reserved: 0,
                },
                // 4 — Velvet Snapdragon: sturdy stems, common, hardy.
                4 => Genome {
                    color_gene: 120,
                    petal_gene: 110,
                    leaf_gene: 140,
                    stem_gene: 200,
                    aroma_gene: 80,
                    climate_gene: 90,
                    recessive_mask: 60,
                    mutation_affinity: 40,
                    stability: 200,
                    reserved: 0,
                },
                // 5 — Twilight Lavendula: dusk-purple, fragrant.
                5 => Genome {
                    color_gene: 90,
                    petal_gene: 160,
                    leaf_gene: 100,
                    stem_gene: 110,
                    aroma_gene: 200,
                    climate_gene: 130,
                    recessive_mask: 50,
                    mutation_affinity: 80,
                    stability: 170,
                    reserved: 0,
                },
                // Defensive neutral genome for any unmapped id.
                _ => Genome {
                    color_gene: 128,
                    petal_gene: 128,
                    leaf_gene: 128,
                    stem_gene: 128,
                    aroma_gene: 128,
                    climate_gene: 128,
                    recessive_mask: 0,
                    mutation_affinity: 64,
                    stability: 128,
                    reserved: 0,
                },
            }
        };

        // Effective parent genomes. `kind` is public, so this select is cheap; the
        // unused branch (e.g. a Starter's zeroed ciphertext) is computed but discarded.
        let a = if parent_a_kind == KIND_STARTER {
            starter(parent_a_species)
        } else {
            parent_a_genome.to_arcis()
        };
        let b = if parent_b_kind == KIND_STARTER {
            starter(parent_b_species)
        } else {
            parent_b_genome.to_arcis()
        };
        let e = env.to_arcis();

        // Per-gene inheritance: pick the value from whichever parent's gene is stronger
        // with higher probability, tilt that probability by an environment `bias`
        // (0..=255, centered at 128), and with ~1/8 probability emit a "mutated" value
        // — a random-jittered blend of both parents. All randomness is MPC-internal.
        let pick = |ga: u8, gb: u8, bias: u8| -> u8 {
            let pick_roll = ArcisRNG::gen_uniform::<u8>();
            let mutate_roll = ArcisRNG::gen_uniform::<u8>();

            // Threshold to favour parent A. Stronger parent gets a higher base (160 vs
            // 96 out of 255); the environment bias nudges it by up to +63.
            let a_stronger = ga >= gb;
            // The environment dial biases inheritance TOWARD THE STRONGER GENE, so a higher
            // dial always pushes this gene group up regardless of which slot the player put
            // the stronger parent in. Previously `threshold = base + bias / 4` always favoured
            // parent A, which made the dial's DIRECTION depend on slot order: with the stronger
            // flower in slot B, turning Light up made colour go DOWN (measured -30 mean colour
            // over 300k trials, vs +30 with this form). `add` is symmetric about the two bases.
            //
            // Ranges: `bias` is a u8 so `add = bias / 4` is at most 63. Upper branch peaks at
            // 160 + 63 = 223 (no u8 overflow); lower branch bottoms at 96 - 63 = 33 (no
            // underflow). `P(inherit stronger) = threshold / 256`, so the dial spans roughly
            // 62.5%..87.1% when A is stronger and the mirror of that when B is.
            //
            // NOTE: splitting this into three INDEPENDENT comparisons (precomputing both
            // candidate thresholds to shorten the dependent chain) was measured and is WORSE —
            // network_depth 118 -> 119 and +0.3% ACU. The Arcis scheduler already handles this
            // chain well; the extra comparison costs more than the reordering saves. Do not
            // retry that transformation.
            let add = bias / 4;
            let threshold = if a_stronger { 160u8 + add } else { 96u8 - add };
            let inherited = if pick_roll < threshold {
                ga
            } else {
                gb
            };

            // Mutation (~1/8 of the time, gated by `mutate_roll < 32` below): emit the TRUE
            // two-parent average instead of the dominant-parent copy. This is a genuine
            // blended-offspring gene — distinct from the `inherited` branch, which copies
            // whichever single parent won the weighted roll. We divide the two-parent SUM by 2
            // (a real average). The prior code divided the sum by 3 with `mutate_roll` folded
            // into the numerator; that had no documented rationale and systematically pulled
            // mutated genes ~29% BELOW the parent average (mean ~90 instead of ~127.5),
            // silently making every `>=`-threshold trait harder to satisfy. Fixed to a true
            // average. No jitter is added: symmetric jitter under Arcis's unsigned arithmetic
            // risks underflow and costs an extra comparison in this closure (which runs 7x per
            // breed), and the mutation is meaningful without it (blend vs dominant-parent copy).
            // `mutate_roll` is therefore used ONLY as the 1/8 gate. Max (255+255)/2 = 255, so
            // the `as u8` cast never truncates.
            let mutated = ((ga as u16 + gb as u16) / 2) as u8;
            if mutate_roll < 32 {
                mutated
            } else {
                inherited
            }
        };

        // Light biases climate/colour; Water biases stem/leaf; Soil biases stability.
        // Genes with no environmental affinity use a neutral bias of 128.
        let color_gene = pick(a.color_gene, b.color_gene, e.light);
        let climate_gene = pick(a.climate_gene, b.climate_gene, e.light);
        let leaf_gene = pick(a.leaf_gene, b.leaf_gene, e.water);
        let stem_gene = pick(a.stem_gene, b.stem_gene, e.water);
        let stability = pick(a.stability, b.stability, e.soil);
        let petal_gene = pick(a.petal_gene, b.petal_gene, 128);
        let aroma_gene = pick(a.aroma_gene, b.aroma_gene, 128);

        // recessive_mask and mutation_affinity are dominated by fresh randomness so the
        // offspring is not predictable from the parents alone (soil tilts mutation).
        let rand_rec = ArcisRNG::gen_uniform::<u8>();
        let recessive_mask =
            ((a.recessive_mask as u16 + b.recessive_mask as u16 + 2 * (rand_rec as u16)) / 4) as u8;
        let rand_mut = ArcisRNG::gen_uniform::<u8>();
        let mutation_affinity = ((rand_mut as u16 + e.soil as u16) / 2) as u8;

        let child = Genome {
            color_gene,
            petal_gene,
            leaf_gene,
            stem_gene,
            aroma_gene,
            climate_gene,
            recessive_mask,
            mutation_affinity,
            stability,
            reserved: 0,
        };

        // --- Stage 3C: public "revealed trait mask" (MPC-determined, PLAINTEXT) ---
        //
        // Four coarse visual classes (0..=4 each) packed into a u32 for the frontend:
        //   bits 0-7  = petal class, 8-15 = color class, 16-23 = leaf class, 24-31 = stem.
        //
        // The mask VALUE is dominated by fresh MPC randomness (`ArcisRNG`, the same secure
        // source the genome uses), nudged only by the PUBLIC parent species ids. We
        // deliberately do NOT fold the secret genome or the secret environment into this
        // REVEALED output: doing so would create a statistical side-channel (an observer
        // collecting many masks from the same parents could infer hidden genome/env
        // values). Because the only non-random inputs are already public (species ids),
        // revealing the mask leaks nothing about the encrypted genome — it is a purely
        // cosmetic, MPC-random label. This is computed AFTER `child`, so the genome output
        // is byte-for-byte unchanged from Stage 3A/3B (no regression to the proven genome).
        // `parent_a_species` / `parent_b_species` are PUBLIC plaintext parameters, so this
        // residue is computed in the clear and costs nothing in MPC. Pre-reducing it is what
        // lets the SECRET modulo below run at u8 width: the old form summed r (0..=255) with
        // species_nudge (0..=510, since a hybrid's species id is 255) and the salt, reaching
        // 768 and forcing a 16-bit modulo.
        let species_nudge_r: u8 = ((parent_a_species as u16 + parent_b_species as u16) % 5) as u8;
        // Distinct salt per class → four independent RNG draws (not one repeated value).
        let class = |salt: u8| -> u8 {
            let r = ArcisRNG::gen_uniform::<u8>();
            // RNG dominates; %5 maps to the five visual classes (slight, harmless bias).
            // Value-identical to the previous `(r + species_nudge + salt) % 5` by modular
            // arithmetic: (r + N) % 5 == ((r % 5) + (N % 5)) % 5. Every operand now stays
            // under 256 — `r % 5` and `(species_nudge_r + salt) % 5` are each 0..=4, so their
            // sum is 0..=8 — which keeps the whole expression at u8 width.
            ((r % 5) + (species_nudge_r + salt) % 5) % 5
        };
        let petal_class = class(0);
        let color_class = class(1);
        let leaf_class = class(2);
        let stem_class = class(3);

        // Arithmetic packing — NOT bitwise (`<<`/`|` are unsupported on secret values in
        // Arcis). Each class < 5 < 256, so `* 256^k` places it in byte-slot k, exactly
        // matching the documented bit layout above.
        let mask: u32 = petal_class as u32
            + (color_class as u32) * 256
            + (leaf_class as u32) * 65_536
            + (stem_class as u32) * 16_777_216;

        // Genome re-encrypted to the MXE (unchanged); mask revealed as public plaintext.
        (Mxe::get().from_arcis(child), mask.reveal())
    }

    /// Scores one entry's encrypted genome against the round's public target traits.
    ///
    /// `target_traits[0..target_trait_count]` are public trait ids (see the on-chain
    /// `constants::TRAIT_TABLE`, which mirrors these ids/names). The trait CONDITIONS are
    /// evaluated only here — the genome is encrypted, so they can never run in plaintext
    /// on-chain; this closure is therefore the canonical definition of each condition.
    ///
    /// Score = the synergy multiplier below: `(matched / count) * (70 + gen_bonus_raw)`,
    /// where `gen_bonus_raw = min(2 * (generation - 1), 30)`. Reaches exactly 100 when every
    /// target trait matches at generation >= 16, and is ZERO at any generation with no
    /// matches. Returned ENCRYPTED so it stays hidden until reveal_top3.
    ///
    /// NAMED `_v2` FOR A DEPLOYMENT REASON, NOT A LOGIC ONE. The synergy circuit is larger
    /// than the flat-bonus one it replaces (163085 B vs 100806 B), so its computation
    /// definition had to be re-registered rather than re-uploaded in place. Closing the old
    /// `score_entry` definition is impossible on shared devnet cluster 456: the on-chain
    /// close checks that the cluster execpool is EMPTY, and another MXE's expired
    /// computations have been wedged in it since 2026-08-02 (only their payer may reclaim
    /// them). Renaming the circuit yields a fresh comp-def offset that needs no close. The
    /// Anchor instruction names are deliberately unchanged, so operator tooling is unaffected.
    #[instruction]
    pub fn score_entry_v2(
        genome: Enc<Mxe, Genome>,
        target_traits: [u8; 4],
        target_trait_count: u8,
        generation: u16,
    ) -> Enc<Mxe, u8> {
        let g = genome.to_arcis();

        // Canonical trait-condition table (kept in sync with constants::TRAIT_TABLE).
        let trait_satisfied = |trait_id: u8| -> bool {
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
        };

        let mut matched: u8 = 0;
        for i in 0..4 {
            let active = (i as u8) < target_trait_count;
            let satisfied = trait_satisfied(target_traits[i]);
            // Count only active slots that match. Both branches always execute in MPC, so
            // gate the increment with the combined (public && secret) condition.
            if active && satisfied {
                matched += 1;
            }
        }

        // Integer match percentage. Guard the divisor (both branches always execute).
        let safe_count = if target_trait_count == 0 {
            1u8
        } else {
            target_trait_count
        };
        // --- SYNERGY MULTIPLIER (permanent formula; REPLACES the temporary +25 flat cap) ---
        //
        //   trait_ratio   = matched / target_trait_count
        //   base          = floor(trait_ratio * 70)
        //   gen_bonus_raw = min(2 * (generation - 1), 30)      // 0 when generation <= 1
        //   gen_bonus     = floor(trait_ratio * gen_bonus_raw)
        //   score         = base + gen_bonus                   // 100 exactly when ratio == 1
        //
        // The generation term is MULTIPLIED by the trait-match ratio, not added flat. A flat
        // bonus let a high-generation flower score well with zero matched traits, which was
        // unfair to new gardeners; now generation only amplifies actual matches. Zero matches
        // scores ZERO no matter the generation.
        //
        // INTEGER ORDER MATTERS: multiply THEN divide in both terms. Computing the ratio first
        // (`matched / safe_count`) would truncate it to 0 or 1 and destroy the whole formula.
        // Both numerators are tiny — matched <= 4, so `matched * 70 <= 280` and
        // `matched * gen_bonus_raw <= 120`, nowhere near u16.
        //
        // `generation` is PUBLIC plaintext, so `gen_bonus_raw` is computed in the clear and
        // costs nothing in MPC. `matched` is secret; the divisor is public.
        let base: u16 = (matched as u16 * 70) / (safe_count as u16);

        // `generation >= 16` short-circuits the cap: 2 * (16 - 1) = 30, so every generation at
        // or above 16 yields exactly 30. Verified equal to `min(2 * (generation - 1), 30)` for
        // every u16 input, while avoiding the overflow the literal form has at generation
        // >= 32769 (and the underflow at generation 0).
        let gen_bonus_raw: u16 = if generation >= 16 {
            30
        } else if generation > 1 {
            2 * (generation - 1)
        } else {
            0
        };
        let gen_bonus: u16 = (matched as u16 * gen_bonus_raw) / (safe_count as u16);

        // Cannot exceed 100 by construction (70 + 30 at ratio 1); the clamp is a guard only.
        let total = base + gen_bonus;
        let score = if total > 100 { 100u8 } else { total as u8 };

        Mxe::get().from_arcis(score)
    }

    /// Private per-player HINT (parallel to `score_entry`; does NOT modify it).
    ///
    /// Answers, privately, which of the round's PUBLIC target traits a player's own
    /// encrypted genome satisfies. The answer is a single `u8` bitmask SEALED to the
    /// requesting player's x25519 key via `client.from_arcis(..)`, so ONLY that player can
    /// decrypt it — nothing is `.reveal()`ed and the output is NOT `Enc<Mxe, _>`, so neither
    /// the operator nor the cluster ever learns the result. `client` is the player's sealing
    /// key, supplied on-chain as an x25519 pubkey (same shape as `start_breeding`'s env key).
    ///
    /// Bit `i` (for `i in 0..target_trait_count`) is set iff `target_traits[i]` is satisfied
    /// by the genome. One byte is all that is needed: the client reconstructs the percentage
    /// and the per-trait checkmarks from this bitmask + the already-public `target_traits`
    /// array + the `TRAIT_TABLE` names. Slots `>= target_trait_count` are always clear.
    #[instruction]
    pub fn private_hint(
        genome: Enc<Mxe, Genome>,
        target_traits: [u8; 4],
        target_trait_count: u8,
        client: Shared,
    ) -> Enc<Shared, u8> {
        let g = genome.to_arcis();

        // ------------------------------------------------------------------------------
        // MUST STAY IN SYNC with `score_entry`'s `trait_satisfied` (above) and with
        // `constants::TRAIT_TABLE`. Copied VERBATIM: Arcis has no shared-helper path that
        // cleanly spans two separate `#[instruction]` fns over the decrypted `Genome` here,
        // so the conditions are duplicated on purpose. If a trait condition changes in
        // `score_entry`, change it here too — otherwise hints and scores would disagree.
        // ------------------------------------------------------------------------------
        let trait_satisfied = |trait_id: u8| -> bool {
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
        };

        // Build the 1-byte bitmask arithmetically. `bit_value[i]` is a PLAINTEXT constant, so
        // `bitmask += bit_value[i]` is add-of-constant on a secret — no bitwise op ever runs
        // on a secret value (unsupported in Arcis; see the `breed` mask comment). Each `i`
        // contributes a distinct bit at most once, so the running sum equals the OR of the
        // set bits. Inactive slots (`i >= target_trait_count`) never add, so their bits stay 0.
        let bit_value: [u8; 4] = [1, 2, 4, 8];
        let mut bitmask: u8 = 0;
        for i in 0..4 {
            let active = (i as u8) < target_trait_count;
            let satisfied = trait_satisfied(target_traits[i]);
            // Both branches always execute in MPC; gate with the combined public+secret cond.
            if active && satisfied {
                bitmask += bit_value[i];
            }
        }

        // Seal to the requesting player only. Not `.reveal()`, not `Enc<Mxe, _>`.
        client.from_arcis(bitmask)
    }

    /// Reveals the top 3 entries (by score, descending) out of up to 16.
    ///
    /// Each `Enc<Mxe, u8>` score is read on-chain from its own `CompetitionEntry` account
    /// (slot `i` = the i-th entry passed to `queue_reveal_top3`), NOT supplied by the
    /// caller — that is the Stage 4B integrity fix. Slots `>= participant_count` are
    /// padding the program supplies (a reused real score) and are masked to 0 here, so
    /// padding never outranks a real entry. The output identifies winners by SLOT index;
    /// the on-chain callback maps each slot back to its entry pubkey (and drops slots
    /// beyond `participant_count`). Only the three winners' slots+scores are revealed —
    /// every other score stays encrypted forever.
    // The 16 score parameters cannot be grouped into a struct/array: each is read in-place
    // from its own CompetitionEntry account (GAP 2, via ArgBuilder::account()), which requires
    // a distinct `Enc<Mxe, u8>` input per entry — Arcis has no way to express a per-element
    // account-backed array here, so the flat parameter list is unavoidable.
    #[allow(clippy::too_many_arguments)]
    #[instruction]
    pub fn reveal_top3(
        s0: Enc<Mxe, u8>,
        s1: Enc<Mxe, u8>,
        s2: Enc<Mxe, u8>,
        s3: Enc<Mxe, u8>,
        s4: Enc<Mxe, u8>,
        s5: Enc<Mxe, u8>,
        s6: Enc<Mxe, u8>,
        s7: Enc<Mxe, u8>,
        s8: Enc<Mxe, u8>,
        s9: Enc<Mxe, u8>,
        s10: Enc<Mxe, u8>,
        s11: Enc<Mxe, u8>,
        s12: Enc<Mxe, u8>,
        s13: Enc<Mxe, u8>,
        s14: Enc<Mxe, u8>,
        s15: Enc<Mxe, u8>,
        participant_count: u8,
    ) -> (u16, u8, u16, u8, u16, u8) {
        let raw = [
            s0.to_arcis(),
            s1.to_arcis(),
            s2.to_arcis(),
            s3.to_arcis(),
            s4.to_arcis(),
            s5.to_arcis(),
            s6.to_arcis(),
            s7.to_arcis(),
            s8.to_arcis(),
            s9.to_arcis(),
            s10.to_arcis(),
            s11.to_arcis(),
            s12.to_arcis(),
            s13.to_arcis(),
            s14.to_arcis(),
            s15.to_arcis(),
        ];

        // Mask inactive slots to 0.
        let mut s = [0u8; 16];
        for i in 0..16 {
            let active = (i as u8) < participant_count;
            s[i] = if active { raw[i] } else { 0u8 };
        }

        // Rank each slot by how many slots beat it (strict score, ties broken by lower
        // index — a stable, plaintext tie-break). Ranks are unique, so ranks 0/1/2 are
        // exactly the top three in order. (O(16x16) compares; fine for N<=16.)
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

        // Reveal only the three winners' slots + scores (outside any conditional).
        (
            top_slot[0].reveal(),
            top_score[0].reveal(),
            top_slot[1].reveal(),
            top_score[1].reveal(),
            top_slot[2].reveal(),
            top_score[2].reveal(),
        )
    }
}
