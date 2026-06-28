use anchor_lang::prelude::*;

/// Number of starter flowers handed out by `claim_starters` — one per species.
/// Mirrored on-chain in `GameConfig::starter_count`, but the value itself is fixed
/// by the length of the `SPECIES` table below.
pub const STARTER_COUNT: u8 = 6;

/// On-chain schema version written to `GameConfig::version`. Bumped whenever the
/// account layout changes (e.g. the Stage 3 genome realloc).
pub const PROGRAM_VERSION: u8 = 1;

/// Stability assigned to every starter flower. Starters are guaranteed-stable
/// reference plants, so they begin at the maximum value on the 0..=100 scale.
pub const STARTER_STABILITY: u8 = 100;

/// PDA seed prefixes. Kept here so the program and clients share one source of truth.
pub const CONFIG_SEED: &[u8] = b"config";
pub const PROFILE_SEED: &[u8] = b"profile";
pub const FLOWER_SEED: &[u8] = b"flower";

/// `FlowerRecord::genome_status` values. Starter flowers carry no encrypted genome
/// in Stage 1; Stage 3 will realloc the account and flip this to `ENCRYPTED` once a
/// ciphertext is attached. The field exists now so client reload logic stays stable.
pub const GENOME_STATUS_STARTER: u8 = 0;
pub const GENOME_STATUS_ENCRYPTED: u8 = 1; // reserved for Stage 3

/// `FlowerRecord::status` values. Stage 1 only ever produces `ACTIVE` flowers;
/// Stage 2 additionally sets `SUBMITTED`.
pub const FLOWER_STATUS_ACTIVE: u8 = 0; // usable
/// Reserved for Stage 3. Stage 2 MUST NOT write this value anywhere.
pub const FLOWER_STATUS_LOCKED: u8 = 1;
/// Flower has been used in a completed challenge entry and is no longer usable.
pub const FLOWER_STATUS_SUBMITTED: u8 = 2;

// --- Stage 2: competition rounds ---

/// PDA seed prefixes for Stage 2 accounts.
pub const ROUND_SEED: &[u8] = b"round";
pub const ENTRY_SEED: &[u8] = b"entry";

/// `CompetitionRound::status` lifecycle values.
pub const ROUND_STATUS_OPEN: u8 = 0;
pub const ROUND_STATUS_CLOSED: u8 = 1;
pub const ROUND_STATUS_FINALIZED: u8 = 2;

/// `CompetitionEntry::status` values. Stage 2 only ever sets `SUBMITTED`.
pub const ENTRY_STATUS_SUBMITTED: u8 = 0;

/// Length of a competition round in seconds: 24 hours (24 * 60 * 60 = 86400).
pub const ROUND_DURATION_SECONDS: i64 = 86_400;

/// Maximum number of entries (participants) allowed per competition round.
pub const MAX_PARTICIPANTS: u16 = 16;

/// Rarity tiers written to `FlowerRecord::rarity` (1 = most common .. 5 = rarest).
pub const RARITY_COMMON: u8 = 1;
pub const RARITY_UNCOMMON: u8 = 2;
pub const RARITY_RARE: u8 = 3;
pub const RARITY_EPIC: u8 = 4;
pub const RARITY_LEGENDARY: u8 = 5; // reserved for non-starter species in later stages

/// Visible-trait bit flags packed into `FlowerRecord::revealed_trait_mask`. A set bit
/// means that cosmetic trait is publicly known. (Stage 3 keeps the remaining traits
/// hidden inside the encrypted genome.)
pub const TRAIT_PETAL_COLOR: u32 = 1 << 0; // bit 0 — base petal colour
pub const TRAIT_PETAL_SHAPE: u32 = 1 << 1; // bit 1 — petal silhouette
pub const TRAIT_LEAF_FORM: u32 = 1 << 2; // bit 2 — leaf / stem form
pub const TRAIT_GLOW: u32 = 1 << 3; // bit 3 — bioluminescent glow
pub const TRAIT_SCENT: u32 = 1 << 4; // bit 4 — scent profile
pub const TRAIT_HEIGHT: u32 = 1 << 5; // bit 5 — plant height

/// Compile-time definition of a starter species. These values live in the program
/// binary (never stored on-chain) and are copied into each `FlowerRecord` at claim
/// time. Every starter reveals its three baseline cosmetic traits (colour, shape,
/// leaf form); rarer species additionally reveal a signature trait.
#[derive(Clone, Copy)]
pub struct SpeciesDef {
    /// Cosmetic species id rendered by the client (mirrors the table index here).
    pub visual_species_id: u8,
    /// Rarity tier (see `RARITY_*`).
    pub rarity: u8,
    /// Which cosmetic traits start revealed (see `TRAIT_*`).
    pub revealed_trait_mask: u32,
}

/// Baseline mask revealed by every starter: the three always-visible cosmetic traits.
const TRAIT_BASELINE: u32 = TRAIT_PETAL_COLOR | TRAIT_PETAL_SHAPE | TRAIT_LEAF_FORM;

/// The six fixed starter species (indices 0..=5). Reference names in comments only.
pub const SPECIES: [SpeciesDef; STARTER_COUNT as usize] = [
    // 0 — Lunar Silkweave: silvery, faintly glowing weave. Uncommon; signature glow.
    SpeciesDef {
        visual_species_id: 0,
        rarity: RARITY_UNCOMMON,
        revealed_trait_mask: TRAIT_BASELINE | TRAIT_GLOW,
    },
    // 1 — Specter Orchid: ghostly, translucent orchid. Rare; signature glow.
    SpeciesDef {
        visual_species_id: 1,
        rarity: RARITY_RARE,
        revealed_trait_mask: TRAIT_BASELINE | TRAIT_GLOW,
    },
    // 2 — Heart's Echo: heart-shaped, strongly perfumed. Uncommon; signature scent.
    SpeciesDef {
        visual_species_id: 2,
        rarity: RARITY_UNCOMMON,
        revealed_trait_mask: TRAIT_BASELINE | TRAIT_SCENT,
    },
    // 3 — Dawnlotus Prime: premium showpiece lotus. Epic; reveals glow and height too.
    SpeciesDef {
        visual_species_id: 3,
        rarity: RARITY_EPIC,
        revealed_trait_mask: TRAIT_BASELINE | TRAIT_GLOW | TRAIT_HEIGHT,
    },
    // 4 — Velvet Snapdragon: sturdy common garden staple. Common; baseline only.
    SpeciesDef {
        visual_species_id: 4,
        rarity: RARITY_COMMON,
        revealed_trait_mask: TRAIT_BASELINE,
    },
    // 5 — Twilight Lavendula: dusk-purple, fragrant spires. Rare; signature scent.
    SpeciesDef {
        visual_species_id: 5,
        rarity: RARITY_RARE,
        revealed_trait_mask: TRAIT_BASELINE | TRAIT_SCENT,
    },
];

// --- Stage 3A: encrypted breeding ---

/// PDA seed prefix for `Experiment` accounts.
pub const EXPERIMENT_SEED: &[u8] = b"experiment";

/// `Experiment::status` lifecycle values. Stage 3A only ever creates `QUEUED`;
/// the remaining transitions happen in Stage 3B (callback / cancel / expire).
pub const EXPERIMENT_STATUS_QUEUED: u8 = 0;
pub const EXPERIMENT_STATUS_PROCESSING: u8 = 1; // reserved for Stage 3B
pub const EXPERIMENT_STATUS_COMPLETED: u8 = 2; // reserved for Stage 3B
pub const EXPERIMENT_STATUS_FAILED: u8 = 3; // reserved for Stage 3B
pub const EXPERIMENT_STATUS_EXPIRED: u8 = 4; // reserved for Stage 3B

// --- Encrypted-genome layout (measured from `arcium build` / build/breed.ts) ---
//
// The breed circuit returns `Enc<Mxe, Genome>`. Genome has 10 `u8` fields, and Arcis
// encrypts each scalar as one BN254 field element serialized to 32 bytes (a 255-bit
// ciphertext). So the ciphertext is 10 * 32 = 320 bytes, plus a 16-byte (u128) nonce.

/// Hash commitment to the encrypted genome (written by Stage 3B). 32-byte digest.
pub const GENOME_COMMITMENT_LEN: usize = 32;
/// Encrypted genome ciphertext: 10 scalars * 32 bytes/scalar = 320 bytes.
pub const ENCRYPTED_GENOME_LEN: usize = 320;
/// Encryption metadata: the MXE nonce, a little-endian u128 = 16 bytes.
pub const ENCRYPTION_METADATA_LEN: usize = 16;

/// Byte offset of `FlowerRecord::encrypted_genome` within the account data, used by the
/// breeding ArgBuilder's `.account()` reference. The genome fields are appended after the
/// original Stage 1/2 layout: 8 (discriminator) + 152 (original fields) + 32
/// (`genome_commitment`) = 192. (3B should re-verify this against the live layout.)
pub const FLOWER_ENCRYPTED_GENOME_OFFSET: u32 = 192;

// --- Stage 3B: breeding resolution ---

/// How long (seconds) a Queued/Processing experiment may sit before anyone can expire
/// it and recover the player's locked parents. 10 minutes.
pub const EXPERIMENT_TIMEOUT_SECONDS: i64 = 600;

/// `visual_species_id` sentinel for bred hybrids. Starter ids are 0..=5, so 255 means
/// "hybrid — appearance is derived from the (encrypted) genome, not a fixed species".
pub const HYBRID_VISUAL_SPECIES_ID: u8 = 255;

/// Stability penalty applied to a hybrid's public stability field (the genetic stability
/// gene itself lives in the encrypted genome and is never read in cleartext here).
pub const BREEDING_STABILITY_PENALTY: u8 = 5;

/// `Experiment::error_code` set by the callback on a failed/aborted computation.
/// Arcium 0.10.4's callback only exposes Success vs Failure (the granular
/// `ExecutionFailure` reason is emitted as an Arcium event, not passed to the callback),
/// so a single sentinel is the most the callback can record.
pub const BREED_ERROR_ABORTED: u16 = 1;

// --- Stage 5D: per-round breeding limit ---

/// Maximum number of `start_breeding` attempts a single wallet may make within one
/// competition round (`GameConfig::current_round`). The counter resets lazily the first
/// time a player breeds in a new round — see `PlayerProfile::register_breed_attempt`.
pub const MAX_BREEDS_PER_ROUND: u8 = 5;

// --- Stage 4A: scoring (target traits + match scoring) ---

/// A public competition trait: a stable id + human-readable name (for the client/UI).
/// The CONDITION each trait checks is defined canonically in the `score_entry` Arcis
/// circuit (the genome is encrypted, so conditions can only be evaluated in MPC); the
/// condition is documented in a comment beside each entry here so the two stay in sync.
pub struct TraitDef {
    pub id: u8,
    pub name: &'static str,
}

/// Number of traits in `TRAIT_TABLE` (used to sample trait ids in `open_round`).
pub const TRAIT_TABLE_LEN: u8 = 10;

/// The public trait table. `id` is the value stored in `CompetitionRound::target_traits`
/// and passed to `score_entry`. Conditions (mirror of the circuit's `trait_satisfied`):
pub const TRAIT_TABLE: [TraitDef; TRAIT_TABLE_LEN as usize] = [
    TraitDef {
        id: 0,
        name: "Crimson",
    }, // color_gene >= 180
    TraitDef {
        id: 1,
        name: "Pale",
    }, // color_gene < 64
    TraitDef {
        id: 2,
        name: "Full Bloom",
    }, // petal_gene >= 150
    TraitDef {
        id: 3,
        name: "Broadleaf",
    }, // leaf_gene >= 128
    TraitDef {
        id: 4,
        name: "Tall",
    }, // stem_gene >= 160
    TraitDef {
        id: 5,
        name: "Fragrant",
    }, // aroma_gene >= 150
    TraitDef {
        id: 6,
        name: "Hardy",
    }, // climate_gene >= 140
    TraitDef {
        id: 7,
        name: "Recessive Carrier",
    }, // recessive_mask >= 32
    TraitDef {
        id: 8,
        name: "Mutant",
    }, // mutation_affinity is odd
    TraitDef {
        id: 9,
        name: "Stable",
    }, // stability >= 150
];

/// A round requests between MIN and MAX target traits. 2 keeps early rounds approachable
/// (a flower can plausibly match all of them); 4 caps difficulty and fits the fixed
/// `target_traits: [u8; 4]` slot count. (Fewer than 2 makes scoring near-binary; more
/// than 4 would not fit the slots and makes the integer percentage jumps very coarse.)
pub const TARGET_TRAIT_MIN: u8 = 2;
pub const TARGET_TRAIT_MAX: u8 = 4;

/// Generation bonus added to a flower's score: +5 per generation above 1, capped so the
/// total score never exceeds `MAX_SCORE`. Mirrors the `score_entry` circuit.
pub const GENERATION_BONUS_PER_GEN: u8 = 5;

/// Maximum possible score (a perfect, capped match percentage).
pub const MAX_SCORE: u8 = 100;

/// Number of winners revealed by `reveal_top3`.
pub const REVEAL_TOP_K: usize = 3;

// --- Stage 4B: per-entry score storage ---

/// Encrypted score ciphertext length: `Enc<Mxe, u8>` = 1 scalar * 32 bytes.
pub const ENTRY_SCORE_LEN: usize = 32;
/// Score nonce length: the MXE nonce, a little-endian u128 = 16 bytes.
pub const ENTRY_SCORE_NONCE_LEN: usize = 16;

/// Byte offset of `CompetitionEntry::encrypted_score` within the account data, used by
/// `queue_reveal_top3`'s `ArgBuilder::account()` reads. The score fields are appended
/// after the original Stage 2 layout: 8 (discriminator) + round(32) + player(32) +
/// flower_record(32) + submitted_at(8) + status(1) + bump(1) = 114.
pub const ENTRY_SCORE_OFFSET: u32 = 114;

/// `CompetitionEntry::score_error_code` set by the callback on a failed score computation.
/// As with breeding, Arcium 0.10.4's callback only exposes Success vs Failure, so this is
/// a single sentinel.
pub const SCORE_ERROR_ABORTED: u16 = 1;

// --- Stage 5A: scoring recovery (cancel_stuck_score) ---

/// How long (seconds) a queued-but-never-callback'd scoring computation may sit before
/// anyone can reset it via `cancel_stuck_score`. 10 minutes.
///
/// Kept as a SEPARATE constant from breeding's `EXPERIMENT_TIMEOUT_SECONDS` (even though
/// both are presently 600s) because `score_entry` and `breed` are distinct circuits with
/// independent MPC latency profiles; decoupling the two recovery windows lets either be
/// tuned without affecting the other.
pub const SCORE_TIMEOUT_SECONDS: i64 = 600;
