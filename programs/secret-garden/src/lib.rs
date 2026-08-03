pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

pub use constants::*;
pub use error::*;
pub use instructions::*;
pub use state::*;

declare_id!("7eMfGCkXavfZeVrwRo3ZH63C7H6mZ6n1HZKJwGkZBddo");

/// Computation-definition offset for the `breed` circuit (must match the circuit's
/// `#[instruction] fn breed` name across all Arcium macros).
const COMP_DEF_OFFSET_BREED: u32 = comp_def_offset("breed");
/// Stage 4A scoring circuits.
const COMP_DEF_OFFSET_SCORE_ENTRY: u32 = comp_def_offset("score_entry_v2");
const COMP_DEF_OFFSET_REVEAL_TOP3: u32 = comp_def_offset("reveal_top3");
/// Private Hint circuit (sealed per-player trait-satisfaction check).
const COMP_DEF_OFFSET_PRIVATE_HINT: u32 = comp_def_offset("private_hint");

/// Compute-unit budget for Arcium callback transactions. Required from Arcium v0.11.0 onward
/// (`queue_computation`'s 7th parameter; it did not exist in v0.10.4). Sized from a MEASURED
/// successful `breed_callback` on devnet, which consumed 94,301 CU on its heaviest path
/// (flatten 10 genome ciphertexts + SHA-256 commitment + ~400-byte account write). 200,000 is
/// Solana's default per-instruction budget and leaves >2x headroom over that worst case; every
/// other callback in this program (score/reveal/hint) writes far less.
const CALLBACK_CU_LIMIT: u32 = 200_000;

/// Secret Garden Protocol.
///
/// Stage 1: game config, player profiles, starter-flower claiming.
/// Stage 2: flower ownership status + daily competition round lifecycle.
/// Stage 3A: encrypted breeding — register the `breed` computation definition and
/// queue breeding computations (the callback that persists results is Stage 3B).
#[arcium_program]
pub mod secret_garden {
    use super::*;

    /// Creates the singleton game config. Callable once.
    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        instructions::initialize_config::handler(ctx)
    }

    /// Creates the caller's player profile. Callable once per wallet.
    pub fn create_profile(ctx: Context<CreateProfile>) -> Result<()> {
        instructions::create_profile::handler(ctx)
    }

    /// Grants the caller their six starter flowers in a single approval. Callable once.
    pub fn claim_starters(ctx: Context<ClaimStarters>) -> Result<()> {
        instructions::claim_starters::handler(ctx)
    }

    /// Operator kill-switch: sets `GameConfig::paused`. Authority-only (Stage 5A). The
    /// `paused` field has existed since Stage 1 but never had an instruction to set it.
    pub fn set_paused(ctx: Context<SetPaused>, new_value: bool) -> Result<()> {
        instructions::set_paused::handler(ctx, new_value)
    }

    // --- Multi-operator support (authority-only administration) ---

    /// Grows the singleton `GameConfig` to the multi-operator layout (appends `operators`
    /// and `operator_count`) and zero-initializes the new fields. Authority-only.
    ///
    /// Like `migrate_profile`, the config is taken as a RAW account: a pre-operator config
    /// is shorter than the current `GameConfig`, so loading it as `Account<GameConfig>` would
    /// fail with `AccountDidNotDeserialize` BEFORE any realloc constraint could run. We grow
    /// it in place, preserving the discriminator and every existing field; `resize`
    /// zero-fills the appended bytes, so `operators = [Pubkey::default(); 3]` and
    /// `operator_count = 0`. Idempotent: a config already at (or above) the new size is a
    /// no-op. Authority is verified by reading the stored authority pubkey directly, since
    /// the raw account cannot be `has_one`-checked. Runs regardless of the pause kill-switch.
    pub fn migrate_config(ctx: Context<MigrateConfig>) -> Result<()> {
        let info = ctx.accounts.config.to_account_info();

        // Verify the signer is the stored authority. Layout: 8-byte discriminator, then the
        // `authority` Pubkey at bytes [8..40] (the very first field, unchanged by this append).
        {
            let data = info.try_borrow_data()?;
            require!(data.len() >= 40, SecretGardenError::NotAuthority);
            let stored_authority = Pubkey::try_from(&data[8..40])
                .map_err(|_| error!(SecretGardenError::NotAuthority))?;
            require_keys_eq!(
                stored_authority,
                ctx.accounts.authority.key(),
                SecretGardenError::NotAuthority
            );
        }

        let new_len = 8 + GameConfig::INIT_SPACE;
        let old_len = info.data_len();

        // Already migrated (or larger): nothing to do.
        if old_len >= new_len {
            return Ok(());
        }

        // Top up rent so the larger account stays rent-exempt.
        let required = Rent::get()?.minimum_balance(new_len);
        let current = info.lamports();
        if required > current {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.authority.to_account_info(),
                        to: info.clone(),
                    },
                ),
                required - current,
            )?;
        }

        // Grow in place; `resize` zero-initializes the appended bytes, so
        // operators = [Pubkey::default(); 3] and operator_count = 0.
        info.resize(new_len)?;
        Ok(())
    }

    /// Registers an additional operator wallet. Authority-only (enforced by `has_one`).
    /// Operators may run rounds (open/close/score/reveal/finalize) but cannot administer.
    pub fn add_operator(ctx: Context<ManageOperator>, new_operator: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(
            new_operator != Pubkey::default(),
            SecretGardenError::InvalidOperator
        );
        // No point adding the authority — it already has every permission.
        require!(
            new_operator != config.authority,
            SecretGardenError::InvalidOperator
        );
        let count = config.operator_count as usize;
        require!(count < 3, SecretGardenError::OperatorSlotsFull);
        require!(
            !config.operators[..count].iter().any(|op| *op == new_operator),
            SecretGardenError::OperatorAlreadyExists
        );
        config.operators[count] = new_operator;
        config.operator_count += 1;
        Ok(())
    }

    /// Removes a registered operator by pubkey, shifting the array left to keep the active
    /// slots contiguous. Authority-only (`has_one`) — operators cannot remove themselves or
    /// each other, so a leaked operator key cannot clean up its own tracks.
    pub fn remove_operator(ctx: Context<ManageOperator>, operator: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let count = config.operator_count as usize;
        let pos = config.operators[..count]
            .iter()
            .position(|op| *op == operator)
            .ok_or(SecretGardenError::OperatorNotFound)?;
        // Shift everything after `pos` left by one, then clear the vacated tail slot.
        for i in pos..count - 1 {
            config.operators[i] = config.operators[i + 1];
        }
        config.operators[count - 1] = Pubkey::default();
        config.operator_count -= 1;
        Ok(())
    }

    // --- Stage 2: competition rounds ---

    /// Opens the next competition round (authority only; previous round must be final).
    pub fn open_round(ctx: Context<OpenRound>) -> Result<()> {
        instructions::open_round::handler(ctx)
    }

    /// Submits one Active flower as an entry into an Open round.
    pub fn submit_entry(ctx: Context<SubmitEntry>) -> Result<()> {
        instructions::submit_entry::handler(ctx)
    }

    /// Closes an Open round (round operator only; may close early or late).
    pub fn close_round(ctx: Context<CloseRound>) -> Result<()> {
        instructions::close_round::handler(ctx)
    }

    /// Finalizes a Closed round (round operator only). No scoring in Stage 2.
    pub fn finalize_round(ctx: Context<FinalizeRound>) -> Result<()> {
        instructions::finalize_round::handler(ctx)
    }

    // --- Stage 3A: encrypted breeding ---

    /// Grows a `FlowerRecord` to the current (genome-bearing) layout via Anchor's
    /// `realloc` constraint. Flowers created by `claim_starters` are already full size
    /// (Anchor's `Account<FlowerRecord>` requires the full layout to deserialize), so
    /// this is an idempotent, owner-only migration/forward-compatibility safeguard.
    pub fn realloc_flower_genome(_ctx: Context<ReallocFlowerGenome>) -> Result<()> {
        Ok(())
    }

    /// Stage 5D migration: grows a pre-5D `PlayerProfile` (created with the smaller layout,
    /// before `breeds_this_round`/`last_breed_round` were appended) by 5 bytes so the
    /// current program can read it. Unlike `realloc_flower_genome`, the profile here is
    /// taken as a RAW account: the old layout is 5 bytes short of `PlayerProfile`, so loading
    /// it as `Account<PlayerProfile>` would fail with `AccountDidNotDeserialize` BEFORE any
    /// realloc constraint could run. We grow it in place, preserving the discriminator and
    /// every existing field, and zero-fill the two appended fields. Idempotent (a profile
    /// already at the new size is a no-op) and owner-only (the PDA seeds bind it to the
    /// signer). Runs regardless of the pause kill-switch — it is a recovery/maintenance op.
    pub fn migrate_profile(ctx: Context<MigrateProfile>) -> Result<()> {
        let info = ctx.accounts.profile.to_account_info();
        let new_len = 8 + PlayerProfile::INIT_SPACE;
        let old_len = info.data_len();

        // Already migrated (or larger): nothing to do.
        if old_len >= new_len {
            return Ok(());
        }

        // Top up rent so the larger account stays rent-exempt.
        let required = Rent::get()?.minimum_balance(new_len);
        let current = info.lamports();
        if required > current {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.owner.to_account_info(),
                        to: info.clone(),
                    },
                ),
                required - current,
            )?;
        }

        // Grow in place; `resize` zero-initializes the 5 appended bytes, so
        // breeds_this_round = 0 and last_breed_round = 0 (the lazy reset does the rest).
        info.resize(new_len)?;
        Ok(())
    }

    /// Registers the `breed` computation definition on-chain. Authority-only, once.
    pub fn init_breeding_comp_def(ctx: Context<InitBreedingCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    /// Queues an encrypted breeding computation for the signer's two Active parents and
    /// records the `Experiment`. One wallet approval; the result is handled in Stage 3B.
    ///
    /// `env_*` carry the player's private environment encrypted as one
    /// `Enc<Shared, Environment>` (single pubkey + nonce + three `u8` ciphertexts). Each
    /// parent's kind/species/nonce are read from its `FlowerRecord`; the parent genome
    /// ciphertext is referenced in-place from the account (zeroed for Starters).
    pub fn start_breeding(
        ctx: Context<StartBreeding>,
        computation_offset: u64,
        env_pubkey: [u8; 32],
        env_nonce: u128,
        light_ciphertext: [u8; 32],
        water_ciphertext: [u8; 32],
        soil_ciphertext: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let player_key = ctx.accounts.player.key();

        // Stage 5D: enforce the per-round breeding limit BEFORE queuing the computation or
        // creating the experiment/offspring accounts (fail fast, no wasted rent or MPC).
        // The counter resets lazily inside `register_breed_attempt` when the round changes.
        let current_round = ctx.accounts.config.current_round as u32;
        ctx.accounts.profile.register_breed_attempt(current_round)?;

        // V1: enforce the hard hybrid-collection cap in the same fail-fast spot. Breeding a
        // new offspring would add one live hybrid, so refuse once the player is already at
        // the cap (`total_flowers - STARTER_COUNT` live hybrids). See `check_collection_cap`.
        ctx.accounts.profile.check_collection_cap()?;

        // Read both parents' public kind/species and their stored genome nonces.
        let flower_a_key = ctx.accounts.flower_a.key();
        let flower_b_key = ctx.accounts.flower_b.key();
        let a_kind = ctx.accounts.flower_a.genome_status;
        let a_species = ctx.accounts.flower_a.visual_species_id;
        let a_nonce = u128::from_le_bytes(ctx.accounts.flower_a.encryption_metadata);
        let b_kind = ctx.accounts.flower_b.genome_status;
        let b_species = ctx.accounts.flower_b.visual_species_id;
        let b_nonce = u128::from_le_bytes(ctx.accounts.flower_b.encryption_metadata);

        // Public offspring metadata (the genome itself is produced by the MPC and
        // written later by the callback).
        let a_generation = ctx.accounts.flower_a.generation;
        let b_generation = ctx.accounts.flower_b.generation;
        let a_stability = ctx.accounts.flower_a.stability;
        let b_stability = ctx.accounts.flower_b.stability;

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // Argument order MUST match the circuit's `breed` parameters left-to-right.
        // Each parent: kind (u8), species (u8), then Enc<Mxe, Genome> = nonce (u128) +
        // its 320-byte ciphertext read by reference from the FlowerRecord account.
        // Finally the Enc<Shared, Environment>: pubkey + nonce + three u8 ciphertexts.
        let args = ArgBuilder::new()
            .plaintext_u8(a_kind)
            .plaintext_u8(a_species)
            .plaintext_u128(a_nonce)
            .account(
                flower_a_key,
                FLOWER_ENCRYPTED_GENOME_OFFSET,
                ENCRYPTED_GENOME_LEN as u32,
            )
            .plaintext_u8(b_kind)
            .plaintext_u8(b_species)
            .plaintext_u128(b_nonce)
            .account(
                flower_b_key,
                FLOWER_ENCRYPTED_GENOME_OFFSET,
                ENCRYPTED_GENOME_LEN as u32,
            )
            .x25519_pubkey(env_pubkey)
            .plaintext_u128(env_nonce)
            .encrypted_u8(light_ciphertext)
            .encrypted_u8(water_ciphertext)
            .encrypted_u8(soil_ciphertext)
            .build();

        // The callback (Stage 3B) writes to these accounts, so register them writable.
        let experiment_key = ctx.accounts.experiment.key();
        let profile_key = ctx.accounts.profile.key();
        let offspring_key = ctx.accounts.offspring.key();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![BreedCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount {
                        pubkey: experiment_key,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: profile_key,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: flower_a_key,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: flower_b_key,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: offspring_key,
                        is_writable: true,
                    },
                ],
            )?],
            1,
            0,
            CALLBACK_CU_LIMIT,
        )?;

        // Lock both parents (the long-reserved FLOWER_STATUS_LOCKED is finally used).
        ctx.accounts.flower_a.status = FLOWER_STATUS_LOCKED;
        ctx.accounts.flower_b.status = FLOWER_STATUS_LOCKED;

        // Pre-create the offspring with its PUBLIC metadata only. Arcium callbacks cannot
        // init accounts, so the genome is written later by `breed_callback`; the flower
        // starts Locked and is flipped to Active only on a successful callback.
        let offspring_index = ctx.accounts.profile.next_flower_index;
        let offspring_generation = a_generation.max(b_generation) + 1;
        let offspring_stability = (((a_stability as u16 + b_stability as u16) / 2) as u8)
            .saturating_sub(BREEDING_STABILITY_PENALTY);
        ctx.accounts.offspring.set_inner(FlowerRecord {
            owner: player_key,
            flower_index: offspring_index,
            visual_species_id: HYBRID_VISUAL_SPECIES_ID,
            generation: offspring_generation,
            rarity: 0, // rarity scoring is a Stage 4/5 concern; unranked for now
            stability: offspring_stability,
            revealed_trait_mask: 0, // nothing revealed yet (Stage 4/5)
            parent_a: flower_a_key,
            parent_b: flower_b_key,
            genome_status: GENOME_STATUS_ENCRYPTED,
            source_experiment: experiment_key,
            status: FLOWER_STATUS_LOCKED,
            created_at: now,
            bump: ctx.bumps.offspring,
            genome_commitment: [0u8; GENOME_COMMITMENT_LEN],
            encrypted_genome: [0u8; ENCRYPTED_GENOME_LEN],
            encryption_metadata: [0u8; ENCRYPTION_METADATA_LEN],
        });

        // Record the experiment (Queued) and advance the profile counters.
        let experiment_index = ctx.accounts.profile.total_experiments;
        ctx.accounts.experiment.set_inner(Experiment {
            owner: player_key,
            parent_a: flower_a_key,
            parent_b: flower_b_key,
            computation_offset,
            status: EXPERIMENT_STATUS_QUEUED,
            result_flower: offspring_key,
            created_at: now,
            updated_at: now,
            error_code: 0,
            callback_processed: false,
            bump: ctx.bumps.experiment,
        });
        ctx.accounts.profile.total_experiments = experiment_index + 1;
        ctx.accounts.profile.active_experiment_count += 1;
        ctx.accounts.profile.total_flowers += 1;
        ctx.accounts.profile.next_flower_index += 1;

        Ok(())
    }

    /// Permissionless recovery: after `EXPERIMENT_TIMEOUT_SECONDS`, anyone can expire a
    /// stuck Queued/Processing experiment to unlock the player's parents. This touches no
    /// Arcium/MPC state. It sets `callback_processed = true`, so if the MPC computation
    /// later completes anyway, `breed_callback`'s idempotency guard makes it a no-op —
    /// preventing a double `active_experiment_count` decrement or a second resolution.
    /// (Trade-off: a successful-but-late computation is discarded; the pre-created
    /// offspring stays Locked. The priority is recovering the player's parent flowers.)
    pub fn cancel_expired_experiment(ctx: Context<CancelExpiredExperiment>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let status = ctx.accounts.experiment.status;
        require!(
            status == EXPERIMENT_STATUS_QUEUED || status == EXPERIMENT_STATUS_PROCESSING,
            SecretGardenError::ExperimentAlreadyResolved
        );
        require!(
            now - ctx.accounts.experiment.created_at >= EXPERIMENT_TIMEOUT_SECONDS,
            SecretGardenError::ExperimentNotYetExpired
        );

        ctx.accounts.flower_a.status = FLOWER_STATUS_ACTIVE;
        ctx.accounts.flower_b.status = FLOWER_STATUS_ACTIVE;

        let experiment = &mut ctx.accounts.experiment;
        experiment.status = EXPERIMENT_STATUS_EXPIRED;
        experiment.callback_processed = true;
        experiment.updated_at = now;

        ctx.accounts.profile.active_experiment_count = ctx
            .accounts
            .profile
            .active_experiment_count
            .saturating_sub(1);
        Ok(())
    }

    /// Permissionless recovery (Stage 5A): closes the pre-created offspring of a
    /// Failed/Expired breeding and returns its rent to the original player. All validity is
    /// enforced by the `ReclaimDeadOffspring` account constraints (experiment is dead, the
    /// offspring is the Locked flower bound to it both ways, rent destination == owner).
    /// Permissionless is safe because the rent destination is fixed to the flower's owner
    /// regardless of who calls — the caller gains nothing. Works while paused (recovery).
    ///
    /// V1 (Option A) accounting: the dead offspring was counted in `total_flowers` at
    /// `start_breeding` time (`+= 1`, done unconditionally for every started breed). Closing
    /// its account here must therefore decrement `total_flowers`, or the collection cap would
    /// permanently over-count phantom hybrids from failed breeds. This keeps
    /// `total_flowers - STARTER_COUNT` an exact live-hybrid count.
    pub fn reclaim_dead_offspring(ctx: Context<ReclaimDeadOffspring>) -> Result<()> {
        ctx.accounts.profile.total_flowers = ctx.accounts.profile.total_flowers.saturating_sub(1);
        Ok(())
    }

    /// V1: closes (deletes) one of the caller's own Active hybrid flowers, refunding its rent
    /// to the owner and freeing a collection slot (`total_flowers -= 1`). All validity is
    /// enforced by the `CloseFlower` account constraints:
    ///   - `flower.owner == owner` (only your own flowers);
    ///   - `flower.status == FLOWER_STATUS_ACTIVE` (excludes Locked mid-breed AND Submitted);
    ///   - `flower.genome_status == GENOME_STATUS_ENCRYPTED` (starters are NEVER deletable —
    ///     this is what preserves the `total_flowers - STARTER_COUNT` accounting invariant);
    ///   - `!config.paused` (a player-facing action, unlike the recovery instructions).
    /// Anchor's `close = owner` returns the rent and prevents any double-close.
    ///
    /// The flower's PDA index is deliberately NOT reused: `next_flower_index` stays monotonic,
    /// so the closed index is retired forever (no PDA re-init risk); the freed slot is tracked
    /// purely by the `total_flowers` decrement.
    pub fn close_flower(ctx: Context<CloseFlower>) -> Result<()> {
        ctx.accounts.profile.total_flowers = ctx.accounts.profile.total_flowers.saturating_sub(1);
        Ok(())
    }

    /// Callback invoked by the Arcium cluster once `breed` finishes.
    ///
    /// On success: writes the offspring genome to the pre-created FlowerRecord, commits to
    /// it, flips it Active, unlocks both parents, and Completes the experiment. On failure:
    /// unlocks both parents and marks the experiment Failed (the offspring stays Locked).
    /// Idempotent via `experiment.callback_processed` — a retried callback no-ops.
    #[arcium_callback(encrypted_ix = "breed")]
    pub fn breed_callback(
        ctx: Context<BreedCallback>,
        output: SignedComputationOutputs<BreedOutput>,
    ) -> Result<()> {
        // A retried callback (or one racing a cancel) must not double-process.
        if ctx.accounts.experiment.callback_processed {
            return Ok(());
        }

        let now = Clock::get()?.unix_timestamp;
        let verified = output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        );

        match verified {
            // Stage 3C: `breed` now returns a tuple `(Enc<Mxe, Genome>, u32)`. Per Arcium's
            // codegen, a tuple return becomes a single `field_0` (BreedOutputStruct0) whose
            // inner `field_0` is the encrypted genome and inner `field_1` is the public
            // `revealed_trait_mask`. The genome handling below is byte-for-byte the same as
            // Stage 3A/3B (the proven Enc<Mxe> path) — only the mask write is added.
            Ok(BreedOutput { field_0: result }) => {
                let genome = result.field_0;
                let revealed_trait_mask = result.field_1;

                // Flatten the 10 ciphertexts into the offspring's encrypted_genome and
                // commit with SHA-256 over (ciphertext || nonce) for independent checks.
                let mut encrypted = [0u8; ENCRYPTED_GENOME_LEN];
                for (i, ct) in genome.ciphertexts.iter().enumerate() {
                    encrypted[i * 32..(i + 1) * 32].copy_from_slice(ct);
                }
                let metadata = genome.nonce.to_le_bytes();
                let commitment =
                    solana_sha256_hasher::hashv(&[&encrypted[..], &metadata[..]]).to_bytes();

                let offspring = &mut ctx.accounts.offspring;
                offspring.encrypted_genome = encrypted;
                offspring.encryption_metadata = metadata;
                offspring.genome_commitment = commitment;
                // Stage 3C: the four packed visual classes (was always 0 before). Public,
                // MPC-random — see the circuit's mask comment; it does NOT leak the genome.
                offspring.revealed_trait_mask = revealed_trait_mask;
                offspring.status = FLOWER_STATUS_ACTIVE;

                ctx.accounts.flower_a.status = FLOWER_STATUS_ACTIVE;
                ctx.accounts.flower_b.status = FLOWER_STATUS_ACTIVE;

                let experiment = &mut ctx.accounts.experiment;
                experiment.status = EXPERIMENT_STATUS_COMPLETED;
                experiment.callback_processed = true;
                experiment.updated_at = now;

                ctx.accounts.profile.active_experiment_count = ctx
                    .accounts
                    .profile
                    .active_experiment_count
                    .saturating_sub(1);

                emit!(BreedingComputedEvent {
                    ciphertexts: genome.ciphertexts,
                    nonce: metadata,
                });
            }
            Err(e) => {
                // Arcium 0.10.4 surfaces only Success vs Failure to the callback (the
                // granular ExecutionFailure is an Arcium event), so record a sentinel.
                msg!("breed computation failed/aborted: {}", e);
                ctx.accounts.flower_a.status = FLOWER_STATUS_ACTIVE;
                ctx.accounts.flower_b.status = FLOWER_STATUS_ACTIVE;

                let experiment = &mut ctx.accounts.experiment;
                experiment.status = EXPERIMENT_STATUS_FAILED;
                experiment.callback_processed = true;
                experiment.error_code = BREED_ERROR_ABORTED;
                experiment.updated_at = now;

                ctx.accounts.profile.active_experiment_count = ctx
                    .accounts
                    .profile
                    .active_experiment_count
                    .saturating_sub(1);
            }
        }
        Ok(())
    }

    // --- Stage 4A: scoring (queue-only; callbacks are stubs, full persistence is 4B) ---

    /// Registers the `score_entry` computation definition. Authority-only, once.
    /// (Two init instructions because Arcium 0.10.4 binds one accounts struct, via
    /// `#[init_computation_definition_accounts]`, to exactly one circuit — a single
    /// `init_scoring_comp_defs` cannot register both.)
    pub fn init_score_entry_comp_def(ctx: Context<InitScoreEntryCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    /// Registers the `reveal_top3` computation definition. Authority-only, once.
    pub fn init_reveal_top3_comp_def(ctx: Context<InitRevealTop3CompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    /// Queues scoring of one entry's flower against the round's public target traits.
    /// Valid once the round is Closed and the entry has NOT already been scored (GAP 1
    /// guard; enforced by the `!entry.scored` constraint on `QueueScoreEntry`). Round
    /// authority signs. The genome is read in-place from the flower account.
    pub fn queue_score_entry(ctx: Context<QueueScoreEntry>, computation_offset: u64) -> Result<()> {
        require!(
            is_operator_or_authority(&ctx.accounts.config, &ctx.accounts.authority.key()),
            SecretGardenError::NotAuthority
        );
        require!(
            ctx.accounts.round.status == ROUND_STATUS_CLOSED,
            SecretGardenError::RoundNotClosed
        );

        let now = Clock::get()?.unix_timestamp;
        let flower_key = ctx.accounts.flower_record.key();
        let genome_nonce = u128::from_le_bytes(ctx.accounts.flower_record.encryption_metadata);
        let target_traits = ctx.accounts.round.target_traits;
        let target_trait_count = ctx.accounts.round.target_trait_count;
        let generation = ctx.accounts.flower_record.generation;
        let entry_key = ctx.accounts.entry.key();
        let round_key = ctx.accounts.round.key();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // Order matches `score_entry`: Enc<Mxe, Genome> (nonce + 320-byte ciphertext by
        // reference), then plaintext target_traits[4], target_trait_count, generation.
        let args = ArgBuilder::new()
            .plaintext_u128(genome_nonce)
            .account(
                flower_key,
                FLOWER_ENCRYPTED_GENOME_OFFSET,
                ENCRYPTED_GENOME_LEN as u32,
            )
            .plaintext_u8(target_traits[0])
            .plaintext_u8(target_traits[1])
            .plaintext_u8(target_traits[2])
            .plaintext_u8(target_traits[3])
            .plaintext_u8(target_trait_count)
            .plaintext_u16(generation)
            .build();

        // The callback persists the score to the entry and bumps round.scored_count.
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ScoreEntryV2Callback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount {
                        pubkey: entry_key,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: round_key,
                        is_writable: true,
                    },
                ],
            )?],
            1,
            0,
            CALLBACK_CU_LIMIT,
        )?;

        // Stage 5A: mark this entry as having a scoring computation in flight, and stamp
        // the queue time so `cancel_stuck_score` can time it out if the callback never
        // lands. Cleared by `score_entry_v2_callback` (success or failure) or by a timed-out
        // `cancel_stuck_score`. `scored_count` is NOT touched here — only the (idempotent)
        // success callback ever increments it, so the count stays exactly-once across any
        // number of queue/cancel/retry cycles.
        ctx.accounts.entry.score_queued = true;
        ctx.accounts.entry.queued_at = now;
        Ok(())
    }

    /// Queues the top-3 reveal for a Closed, fully-scored round. Authority-only.
    ///
    /// GAP 2 fix: the encrypted scores are NOT supplied by the caller. The round's
    /// `CompetitionEntry` accounts are passed as `remaining_accounts` (exactly
    /// `participant_count` of them); the program validates each belongs to the round and
    /// is scored, then builds the circuit args by reading each entry's stored score
    /// ciphertext in-place via `ArgBuilder::account()`. Slots beyond `participant_count`
    /// are padded with the first entry's (real, MAC-valid) score, which the circuit masks
    /// to 0 — so a caller can never substitute arbitrary score data.
    pub fn queue_reveal_top3(ctx: Context<QueueRevealTop3>, computation_offset: u64) -> Result<()> {
        require!(
            is_operator_or_authority(&ctx.accounts.config, &ctx.accounts.authority.key()),
            SecretGardenError::NotAuthority
        );
        let round_key = ctx.accounts.round.key();
        require!(
            ctx.accounts.round.status == ROUND_STATUS_CLOSED,
            SecretGardenError::RoundNotClosed
        );
        require!(
            !ctx.accounts.round.scoring_revealed,
            SecretGardenError::ScoringAlreadyRevealed
        );
        require!(
            ctx.accounts.round.scored_count == ctx.accounts.round.participant_count,
            SecretGardenError::ScoringIncomplete
        );
        let participant_count = ctx.accounts.round.participant_count as usize;
        require!(
            (1..=MAX_PARTICIPANTS as usize).contains(&participant_count),
            SecretGardenError::ScoringIncomplete
        );
        require!(
            ctx.remaining_accounts.len() == participant_count,
            SecretGardenError::WrongEntryCount
        );

        // Validate each entry belongs to the round and is scored; collect (pubkey, nonce).
        let mut entry_keys = [Pubkey::default(); MAX_PARTICIPANTS as usize];
        let mut entry_nonces = [0u128; MAX_PARTICIPANTS as usize];
        for (i, info) in ctx.remaining_accounts.iter().enumerate() {
            let entry = Account::<CompetitionEntry>::try_from(info)?;
            require!(entry.round == round_key, SecretGardenError::WrongEntryCount);
            require!(entry.scored, SecretGardenError::ScoringIncomplete);
            entry_keys[i] = info.key();
            entry_nonces[i] = u128::from_le_bytes(entry.score_nonce);
        }
        // Pad unused slots with the first entry (the circuit masks them to 0).
        for i in participant_count..MAX_PARTICIPANTS as usize {
            entry_keys[i] = entry_keys[0];
            entry_nonces[i] = entry_nonces[0];
        }

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // 16 x Enc<Mxe, u8>: each is a nonce + the 32-byte score ciphertext read in-place
        // from the entry's account, then plaintext participant_count.
        let mut builder = ArgBuilder::new();
        for i in 0..MAX_PARTICIPANTS as usize {
            builder = builder.plaintext_u128(entry_nonces[i]).account(
                entry_keys[i],
                ENTRY_SCORE_OFFSET,
                ENTRY_SCORE_LEN as u32,
            );
        }
        let args = builder.plaintext_u8(participant_count as u8).build();

        // Register round (writable) + the real entries (read), in slot order, so the
        // callback can map the winning SLOT indices back to entry pubkeys.
        let mut callback_accs = vec![CallbackAccount {
            pubkey: round_key,
            is_writable: true,
        }];
        for key in entry_keys.iter().take(participant_count) {
            callback_accs.push(CallbackAccount {
                pubkey: *key,
                is_writable: false,
            });
        }

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![RevealTop3Callback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &callback_accs,
            )?],
            1,
            0,
            CALLBACK_CU_LIMIT,
        )?;
        Ok(())
    }

    /// On success: persists the entry's encrypted score, marks it `scored`, and bumps
    /// `round.scored_count` (saturating). Idempotent via `entry.scored` — a retried or
    /// raced callback no-ops, which is what makes the GAP 1 double-count structurally
    /// impossible even if `queue_score_entry` were somehow called twice before the first
    /// callback lands. On failure: records a sentinel error_code and leaves `scored =
    /// false` so the entry can be re-queued.
    #[arcium_callback(encrypted_ix = "score_entry_v2")]
    pub fn score_entry_v2_callback(
        ctx: Context<ScoreEntryV2Callback>,
        output: SignedComputationOutputs<ScoreEntryV2Output>,
    ) -> Result<()> {
        if ctx.accounts.entry.scored {
            return Ok(());
        }
        let verified = output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        );
        match verified {
            Ok(ScoreEntryV2Output { field_0: score }) => {
                let entry = &mut ctx.accounts.entry;
                entry.encrypted_score = score.ciphertexts[0];
                entry.score_nonce = score.nonce.to_le_bytes();
                entry.scored = true;
                // Stage 5A: computation resolved — clear the in-flight flag.
                entry.score_queued = false;
                ctx.accounts.round.scored_count = ctx.accounts.round.scored_count.saturating_add(1);
                emit!(ScoreComputedEvent {
                    ciphertext: score.ciphertexts[0],
                    nonce: score.nonce.to_le_bytes(),
                });
            }
            Err(e) => {
                msg!("score_entry computation failed/aborted: {}", e);
                ctx.accounts.entry.score_error_code = SCORE_ERROR_ABORTED;
                // Stage 5A: clear the in-flight flag so the entry can be re-queued
                // immediately (it stays `scored = false`).
                ctx.accounts.entry.score_queued = false;
            }
        }
        Ok(())
    }

    /// Permissionless recovery (Stage 5A): if a scoring computation was queued but its
    /// callback never landed, anyone can reset the entry's in-flight flag after
    /// `SCORE_TIMEOUT_SECONDS` so `queue_score_entry` can be called again. Mirrors
    /// `cancel_expired_experiment`. Nothing is "unlocked" (the entry's flower stays
    /// Submitted regardless), and `round.scored_count` is untouched — it is only ever
    /// incremented by the success callback, so a cancel-then-retry that eventually
    /// succeeds counts exactly once, and one that never succeeds counts zero. Works while
    /// paused: a stuck score must be recoverable even if new game actions are halted.
    pub fn cancel_stuck_score(ctx: Context<CancelStuckScore>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let entry = &mut ctx.accounts.entry;
        // Already-scored entries are terminal — nothing to recover.
        require!(!entry.scored, SecretGardenError::EntryAlreadyScored);
        // Only an in-flight (queued) entry can be reset.
        require!(entry.score_queued, SecretGardenError::ScoreNotQueued);
        require!(
            now - entry.queued_at >= SCORE_TIMEOUT_SECONDS,
            SecretGardenError::ScoreNotYetTimedOut
        );
        // Re-queueable: clear the in-flight flag. `queued_at` is left as-is (the next
        // `queue_score_entry` overwrites it); `scored_count` is deliberately not touched.
        entry.score_queued = false;
        Ok(())
    }

    /// On success: maps each winning SLOT index back to its entry pubkey and writes
    /// top1/top2/top3 — but `top_k` only when `participant_count >= k` (GAP 3). Unfilled
    /// slots stay `Pubkey::default()`, which is unambiguous: a real entry is a program PDA
    /// and can never be at the all-zero default. Sets `scoring_revealed`. Idempotent: a
    /// duplicate callback on an already-revealed round no-ops.
    #[arcium_callback(encrypted_ix = "reveal_top3")]
    pub fn reveal_top3_callback(
        ctx: Context<RevealTop3Callback>,
        output: SignedComputationOutputs<RevealTop3Output>,
    ) -> Result<()> {
        if ctx.accounts.round.scoring_revealed {
            return Ok(());
        }
        let RevealTop3Output { field_0: top } = output
            .verify_output(
                &ctx.accounts.cluster_account,
                &ctx.accounts.computation_account,
            )
            .map_err(|e| {
                msg!("reveal_top3 verify failed: {}", e);
                SecretGardenError::AbortedComputation
            })?;

        // The winning slots index into the registered entry accounts (remaining_accounts),
        // which are the round's entries in the same order passed to queue_reveal_top3. For
        // every written rank, the winning slot is < participant_count (real entries always
        // outrank the zero-padded slots), so the index is in bounds.
        let n = ctx.remaining_accounts.len();
        let participant_count = ctx.accounts.round.participant_count;

        let mut top1 = Pubkey::default();
        let mut top2 = Pubkey::default();
        let mut top3 = Pubkey::default();
        if participant_count >= 1 {
            let s = top.field_0 as usize;
            require!(s < n, SecretGardenError::WrongEntryCount);
            top1 = ctx.remaining_accounts[s].key();
        }
        if participant_count >= 2 {
            let s = top.field_2 as usize;
            require!(s < n, SecretGardenError::WrongEntryCount);
            top2 = ctx.remaining_accounts[s].key();
        }
        if participant_count >= 3 {
            let s = top.field_4 as usize;
            require!(s < n, SecretGardenError::WrongEntryCount);
            top3 = ctx.remaining_accounts[s].key();
        }

        let round = &mut ctx.accounts.round;
        round.top1 = top1;
        round.top2 = top2;
        round.top3 = top3;
        round.scoring_revealed = true;

        emit!(Top3RevealedEvent {
            entry_index_1: top.field_0,
            score_1: top.field_1,
            entry_index_2: top.field_2,
            score_2: top.field_3,
            entry_index_3: top.field_4,
            score_3: top.field_5,
        });
        Ok(())
    }

    // --- Private Hint: per-player sealed trait-satisfaction check ---

    /// Registers the `private_hint` computation definition on-chain. Authority-only, once.
    /// Same shape as the other `init_*_comp_def` instructions.
    pub fn init_private_hint_comp_def(ctx: Context<InitPrivateHintCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    /// Queues a `private_hint` computation for one of the SIGNER'S OWN flowers against the
    /// CURRENT open round's public target traits. The MPC seals a 1-byte trait-satisfaction
    /// bitmask to the player's supplied x25519 key, so only they can decrypt the answer.
    ///
    /// Guards (all enforced by `QueuePrivateHint`'s account constraints, so they fail cleanly
    /// with a specific error rather than doing nothing):
    ///   - the flower is owned by the signer and is NOT Locked (mid-breed) — Active or
    ///     Submitted flowers are both hint-checkable;
    ///   - the round is the current one AND is Open (`NoActiveRound` otherwise).
    ///
    /// `hint_pubkey` / `hint_nonce` are the player's sealing key material (same shape as
    /// `start_breeding`'s `env_pubkey` / `env_nonce`). The genome ciphertext is read in-place
    /// from the flower account (never supplied by the caller), exactly like `queue_score_entry`.
    pub fn queue_private_hint(
        ctx: Context<QueuePrivateHint>,
        computation_offset: u64,
        hint_pubkey: [u8; 32],
        hint_nonce: u128,
    ) -> Result<()> {
        let player_key = ctx.accounts.player.key();
        let flower_key = ctx.accounts.flower.key();
        let genome_nonce = u128::from_le_bytes(ctx.accounts.flower.encryption_metadata);
        let target_traits = ctx.accounts.round.target_traits;
        let target_trait_count = ctx.accounts.round.target_trait_count;
        let round_id = ctx.accounts.round.round_id;
        let hint_key = ctx.accounts.hint_result.key();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // Order matches the `private_hint` circuit params left-to-right:
        //   Enc<Mxe, Genome>  -> nonce (u128) + 320-byte ciphertext read by reference,
        //   target_traits[4]  -> four plaintext u8,
        //   target_trait_count-> plaintext u8,
        //   client: Shared    -> x25519 sealing pubkey + a client-supplied u128 nonce. A bare
        //                        `Shared` recipient is encoded as (pubkey, nonce) — the SAME
        //                        shape as an `Enc<Shared, _>` input MINUS its ciphertexts (cf.
        //                        `start_breeding`'s env: pubkey + nonce + ciphertexts). Omitting
        //                        the nonce makes the Arcium program reject the queue with
        //                        `invalidArguments` (0x189d), so both parts are required.
        let args = ArgBuilder::new()
            .plaintext_u128(genome_nonce)
            .account(
                flower_key,
                FLOWER_ENCRYPTED_GENOME_OFFSET,
                ENCRYPTED_GENOME_LEN as u32,
            )
            .plaintext_u8(target_traits[0])
            .plaintext_u8(target_traits[1])
            .plaintext_u8(target_traits[2])
            .plaintext_u8(target_traits[3])
            .plaintext_u8(target_trait_count)
            .x25519_pubkey(hint_pubkey)
            .plaintext_u128(hint_nonce)
            .build();

        // The callback persists the sealed ciphertext into the player's hint account.
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![PrivateHintCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: hint_key,
                    is_writable: true,
                }],
            )?],
            1,
            0,
            CALLBACK_CU_LIMIT,
        )?;

        // Initialize / reset the per-player hint account. `ready = false` marks the previous
        // answer (if any) as stale until this computation's callback lands — the ciphertext
        // is left as-is (guarded by `ready`) and overwritten on success. Overwriting the same
        // PDA keeps exactly one small account per player (no per-flower rent bloat / history).
        let hint = &mut ctx.accounts.hint_result;
        hint.player = player_key;
        hint.round_id = round_id;
        hint.target_trait_count = target_trait_count;
        hint.ready = false;
        hint.bump = ctx.bumps.hint_result;
        Ok(())
    }

    /// Callback invoked by the Arcium cluster once `private_hint` finishes. Persists the
    /// sealed bitmask (ciphertext + nonce + encryption key) into the player's `HintResult`
    /// and flips `ready = true`. On failure it leaves `ready = false` so the client keeps
    /// showing "no hint yet" and the player can simply re-request. There is no idempotency
    /// flag to guard: a duplicate success callback just rewrites the identical sealed bytes.
    #[arcium_callback(encrypted_ix = "private_hint")]
    pub fn private_hint_callback(
        ctx: Context<PrivateHintCallback>,
        output: SignedComputationOutputs<PrivateHintOutput>,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let verified = output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        );
        match verified {
            // `private_hint` returns `Enc<Shared, u8>` -> a single `field_0` that is a
            // `SharedEncryptedStruct<1>` (encryption_key + nonce + one ciphertext scalar).
            Ok(PrivateHintOutput { field_0: sealed }) => {
                let hint = &mut ctx.accounts.hint_result;
                hint.encryption_key = sealed.encryption_key;
                hint.nonce = sealed.nonce.to_le_bytes();
                hint.ciphertext = sealed.ciphertexts[0];
                hint.ready = true;
                hint.computed_at = now;
                emit!(HintComputedEvent {
                    player: hint.player,
                    round_id: hint.round_id,
                });
            }
            Err(e) => {
                // Arcium 0.10.4 only surfaces Success vs Failure to the callback. Leave the
                // result not-ready so the client reports "no hint yet" and the player retries.
                msg!("private_hint computation failed/aborted: {}", e);
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Stage 3A: Arcium account contexts for breeding.
//
// These mirror the arcium 0.10.4 generated templates (boxed heavy queue-side
// accounts, one-argument derive_*_pda! macros, init_computation_def helper).
// ---------------------------------------------------------------------------

/// Grows a flower to the genome-bearing layout (see `realloc_flower_genome`).
#[derive(Accounts)]
pub struct ReallocFlowerGenome<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        realloc = 8 + FlowerRecord::INIT_SPACE,
        realloc::payer = owner,
        realloc::zero = false,
        constraint = flower.owner == owner.key() @ SecretGardenError::FlowerNotOwned,
    )]
    pub flower: Box<Account<'info, FlowerRecord>>,
    pub system_program: Program<'info, System>,
}

/// Grows a pre-5D `PlayerProfile` by 5 bytes (see `migrate_profile`). The profile is taken
/// as a raw account because the old (shorter) layout cannot be deserialized as
/// `PlayerProfile`; the PDA seeds bind it to the signing owner, and the `owner` constraint
/// ensures the account is actually one of this program's profiles.
#[derive(Accounts)]
pub struct MigrateProfile<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: deserialized/realloc'd manually; the old layout is 5 bytes short of
    /// `PlayerProfile`, so it cannot be loaded as a typed `Account`.
    #[account(
        mut,
        seeds = [PROFILE_SEED, owner.key().as_ref()],
        bump,
        owner = crate::ID,
    )]
    pub profile: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Grows the singleton `GameConfig` to the multi-operator layout (see `migrate_config`).
/// The config is taken as a raw account because a pre-operator config is shorter than the
/// current `GameConfig` and cannot be loaded as a typed `Account`. The `config` PDA seeds
/// bind it to this program; the authority is verified inside the handler against the stored
/// authority pubkey (a raw account cannot be `has_one`-checked).
#[derive(Accounts)]
pub struct MigrateConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: deserialized/realloc'd manually; a pre-operator config is shorter than
    /// `GameConfig`, so it cannot be loaded as a typed `Account`.
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        owner = crate::ID,
    )]
    pub config: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Authority-only operator administration (`add_operator` / `remove_operator`). Runs after
/// `migrate_config`, so the config is at the full layout and loads as a typed account; the
/// `has_one` is what makes these instructions authority-only (operators cannot self-manage).
#[derive(Accounts)]
pub struct ManageOperator<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ SecretGardenError::NotAuthority,
    )]
    pub config: Account<'info, GameConfig>,
}

/// Registers the `breed` computation definition. Restricted to `config.authority`.
#[init_computation_definition_accounts("breed", authority)]
#[derive(Accounts)]
pub struct InitBreedingCompDef<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ SecretGardenError::NotAuthority,
    )]
    pub config: Account<'info, GameConfig>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by the arcium program. Not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by the arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

/// Queues a `breed` computation. The signer (`player`) funds the new accounts and must
/// own both Active parents; the two parents must be distinct flowers.
#[queue_computation_accounts("breed", player)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct StartBreeding<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    /// Game config, read to enforce the pause kill-switch (Stage 5A: this player-facing
    /// instruction previously had no pause gate — added here, logic otherwise unchanged).
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ SecretGardenError::GamePaused,
    )]
    pub config: Box<Account<'info, GameConfig>>,

    // --- game state ---
    // Boxed to keep `try_accounts` off the SBF stack: FlowerRecord is large once the
    // genome fields are present, and two of them plus the queued Arcium accounts would
    // otherwise overflow the 4 KB stack frame.
    // The PDA seeds bind this profile to `player`, so it is necessarily the signer's.
    #[account(
        mut,
        seeds = [PROFILE_SEED, player.key().as_ref()],
        bump = profile.bump,
    )]
    pub profile: Box<Account<'info, PlayerProfile>>,
    // Parents are created full-size by `claim_starters`, so no realloc is needed here;
    // the `realloc` constraint pattern lives in `realloc_flower_genome`.
    #[account(
        mut,
        constraint = flower_a.owner == player.key() @ SecretGardenError::FlowerNotOwned,
        constraint = flower_a.status != FLOWER_STATUS_LOCKED @ SecretGardenError::FlowerNotActive,
    )]
    pub flower_a: Box<Account<'info, FlowerRecord>>,
    #[account(
        mut,
        constraint = flower_b.key() != flower_a.key() @ SecretGardenError::ParentsMustBeDistinct,
        constraint = flower_b.owner == player.key() @ SecretGardenError::FlowerNotOwned,
        constraint = flower_b.status != FLOWER_STATUS_LOCKED @ SecretGardenError::FlowerNotActive,
    )]
    pub flower_b: Box<Account<'info, FlowerRecord>>,
    #[account(
        init,
        payer = player,
        space = 8 + Experiment::INIT_SPACE,
        seeds = [
            EXPERIMENT_SEED,
            player.key().as_ref(),
            profile.total_experiments.to_le_bytes().as_ref(),
        ],
        bump,
    )]
    pub experiment: Box<Account<'info, Experiment>>,
    /// Offspring flower, pre-created here (Arcium callbacks cannot init accounts). Its
    /// index is the wallet's running `total_flowers` (starters occupy 0..=5). The genome
    /// is written by `breed_callback`.
    #[account(
        init,
        payer = player,
        space = 8 + FlowerRecord::INIT_SPACE,
        seeds = [
            FLOWER_SEED,
            player.key().as_ref(),
            profile.next_flower_index.to_le_bytes().as_ref(),
        ],
        bump,
    )]
    pub offspring: Box<Account<'info, FlowerRecord>>,

    // --- arcium queue-side accounts (heavy accounts boxed, per v0.10) ---
    #[account(
        init_if_needed,
        space = SIGN_PDA_ACCOUNT_LEN,
        payer = player,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_BREED))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    // Boxed (Stage 5A): adding the `config` pause-check account pushed `try_accounts`
    // 8 bytes over the 4 KB SBF stack frame; boxing these two heap-allocates their
    // deserialized data, recovering the headroom. `Box<Account<_>>` derefs transparently
    // for the `#[queue_computation_accounts]` macro (it uses `.to_account_info()`).
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

/// Callback context for `breed`. The six framework accounts come first (fixed order
/// required by `#[callback_accounts]`); the writable game accounts follow in the SAME
/// order they are registered in `start_breeding`'s `callback_ix` extra-accounts list.
/// They are bound to the experiment so the callback can only touch the right records.
#[callback_accounts("breed")]
#[derive(Accounts)]
pub struct BreedCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_BREED))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by the arcium program via callback constraints.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint.
    pub instructions_sysvar: UncheckedAccount<'info>,

    // --- writable game accounts (order matches start_breeding's extra_accs) ---
    #[account(mut)]
    pub experiment: Box<Account<'info, Experiment>>,
    #[account(mut, constraint = profile.owner == experiment.owner)]
    pub profile: Box<Account<'info, PlayerProfile>>,
    #[account(mut, constraint = flower_a.key() == experiment.parent_a)]
    pub flower_a: Box<Account<'info, FlowerRecord>>,
    #[account(mut, constraint = flower_b.key() == experiment.parent_b)]
    pub flower_b: Box<Account<'info, FlowerRecord>>,
    #[account(mut, constraint = offspring.key() == experiment.result_flower)]
    pub offspring: Box<Account<'info, FlowerRecord>>,
}

/// Permissionless recovery of a stuck experiment (see `cancel_expired_experiment`).
#[derive(Accounts)]
pub struct CancelExpiredExperiment<'info> {
    /// Anyone may call this; the caller only pays the transaction fee.
    pub caller: Signer<'info>,
    #[account(mut)]
    pub experiment: Box<Account<'info, Experiment>>,
    #[account(mut, constraint = profile.owner == experiment.owner)]
    pub profile: Box<Account<'info, PlayerProfile>>,
    #[account(mut, constraint = flower_a.key() == experiment.parent_a)]
    pub flower_a: Box<Account<'info, FlowerRecord>>,
    #[account(mut, constraint = flower_b.key() == experiment.parent_b)]
    pub flower_b: Box<Account<'info, FlowerRecord>>,
}

/// Permissionless reclaim of a dead breeding's offspring (see `reclaim_dead_offspring`).
///
/// NOTE on validity: the task framing assumed `experiment.result_flower` is unset
/// (`Pubkey::default()`) for a non-successful breeding, but `start_breeding` populates
/// `result_flower` with the offspring key at creation time — it is the SAME value for a
/// successful or a failed experiment. So the real "this offspring was never a successful
/// result" signal is `offspring.status == LOCKED` (the breed callback flips a successful
/// offspring to `ACTIVE`, a failure/expiry leaves it `LOCKED`), combined with the
/// experiment being Failed/Expired and the offspring being bound to it both ways. Those
/// are exactly the constraints enforced below.
#[derive(Accounts)]
pub struct ReclaimDeadOffspring<'info> {
    /// Anyone may call this; the caller gains nothing (rent is fixed to the flower owner).
    pub caller: Signer<'info>,
    /// The breeding experiment — must be Failed or Expired.
    #[account(
        constraint = (experiment.status == EXPERIMENT_STATUS_FAILED
            || experiment.status == EXPERIMENT_STATUS_EXPIRED)
            @ SecretGardenError::ExperimentNotDead,
    )]
    pub experiment: Box<Account<'info, Experiment>>,
    /// The pre-created offspring tied to `experiment`. Reclaimable only if it is still
    /// `LOCKED` (a successful breeding would have flipped it `ACTIVE`) AND bound to the
    /// experiment in both directions. `close` returns its rent to `owner_recipient` and
    /// also prevents any double-close (the account no longer exists afterwards).
    #[account(
        mut,
        close = owner_recipient,
        constraint = offspring.source_experiment == experiment.key()
            @ SecretGardenError::OffspringNotReclaimable,
        constraint = experiment.result_flower == offspring.key()
            @ SecretGardenError::OffspringNotReclaimable,
        constraint = offspring.status == FLOWER_STATUS_LOCKED
            @ SecretGardenError::OffspringNotReclaimable,
    )]
    pub offspring: Box<Account<'info, FlowerRecord>>,
    /// Rent destination — must equal the flower's recorded owner (product decision: rent
    /// returns to the player who paid it, not the caller and not the operator).
    #[account(
        mut,
        constraint = owner_recipient.key() == offspring.owner
            @ SecretGardenError::InvalidRentDestination,
    )]
    /// CHECK: not read or written as a typed account; only receives the reclaimed
    /// lamports. Constrained above to equal `offspring.owner`.
    pub owner_recipient: UncheckedAccount<'info>,
    /// The offspring owner's profile — decremented so `total_flowers` stops counting this
    /// reclaimed dead hybrid (V1 Option A accounting). The PDA seeds bind it to
    /// `offspring.owner`, so a permissionless caller cannot substitute a different profile.
    /// (Declared after `offspring` so its `owner` field is available to the seeds.)
    #[account(
        mut,
        seeds = [PROFILE_SEED, offspring.owner.as_ref()],
        bump = profile.bump,
    )]
    pub profile: Box<Account<'info, PlayerProfile>>,
}

/// Accounts for `close_flower` — a player deleting one of their own Active hybrids. Reuses
/// the `reclaim_dead_offspring` close pattern (`#[account(close = ...)]`), here self-closing
/// to the signing owner. Pause-gated via `config` (matching every other player-facing
/// instruction, e.g. `submit_entry` / `start_breeding`).
#[derive(Accounts)]
pub struct CloseFlower<'info> {
    /// The flower's owner; signs, and receives the reclaimed rent.
    #[account(mut)]
    pub owner: Signer<'info>,

    /// Pause kill-switch: deleting is a player-facing action, blocked while paused.
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ SecretGardenError::GamePaused,
    )]
    pub config: Account<'info, GameConfig>,

    /// Owner's profile — `total_flowers` is decremented to free the collection slot. The PDA
    /// seeds bind it to the signer, so it is necessarily the caller's own profile.
    #[account(
        mut,
        seeds = [PROFILE_SEED, owner.key().as_ref()],
        bump = profile.bump,
    )]
    pub profile: Account<'info, PlayerProfile>,

    /// The flower to delete. `close = owner` refunds its rent to the owner; the constraints
    /// enforce ownership, that it is Active (not Locked/Submitted), and that it is a hybrid
    /// (never a starter). No `seeds` needed: Anchor proves it is a program-owned FlowerRecord,
    /// and the `owner` constraint proves it belongs to the signer.
    #[account(
        mut,
        close = owner,
        constraint = flower.owner == owner.key() @ SecretGardenError::FlowerNotOwned,
        constraint = flower.status == FLOWER_STATUS_ACTIVE @ SecretGardenError::FlowerNotActive,
        constraint = flower.genome_status == GENOME_STATUS_ENCRYPTED
            @ SecretGardenError::StarterNotDeletable,
    )]
    pub flower: Account<'info, FlowerRecord>,
}

/// Permissionless reset of a stuck scoring computation (see `cancel_stuck_score`). No
/// config (pause) account — recovery must work even while the game is paused. No PDA seed
/// re-derivation is needed: Anchor already proves `entry` is a program-owned
/// `CompetitionEntry`, and the only effect is clearing the in-flight flag, which merely
/// re-enables an authority-gated `queue_score_entry`.
#[derive(Accounts)]
pub struct CancelStuckScore<'info> {
    /// Anyone may call this; the caller only pays the transaction fee.
    pub caller: Signer<'info>,
    #[account(mut)]
    pub entry: Box<Account<'info, CompetitionEntry>>,
}

/// Emitted by `breed_callback` when a breeding computation succeeds.
#[event]
pub struct BreedingComputedEvent {
    /// The offspring genome ciphertext (10 scalars * 32 bytes).
    pub ciphertexts: [[u8; 32]; 10],
    /// The MXE nonce (little-endian u128).
    pub nonce: [u8; 16],
}

// ---------------------------------------------------------------------------
// Stage 4A: Arcium account contexts for scoring (mirror the breeding contexts).
// ---------------------------------------------------------------------------

/// Registers the `score_entry` computation definition. Restricted to `config.authority`.
#[init_computation_definition_accounts("score_entry_v2", authority)]
#[derive(Accounts)]
pub struct InitScoreEntryCompDef<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ SecretGardenError::NotAuthority,
    )]
    pub config: Account<'info, GameConfig>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by the arcium program. Not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by the arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

/// Registers the `reveal_top3` computation definition. Restricted to `config.authority`.
#[init_computation_definition_accounts("reveal_top3", authority)]
#[derive(Accounts)]
pub struct InitRevealTop3CompDef<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ SecretGardenError::NotAuthority,
    )]
    pub config: Account<'info, GameConfig>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by the arcium program. Not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by the arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

/// Queues a `score_entry` computation for one entry in a Closed round. Round authority
/// signs and funds. The entry is bound to the round and to the flower being scored.
#[queue_computation_accounts("score_entry_v2", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct QueueScoreEntry<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Game config, read to enforce the pause kill-switch (Stage 5A: scoring is game
    /// progression, so it is halted while paused; check added here, logic unchanged).
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ SecretGardenError::GamePaused,
    )]
    pub config: Box<Account<'info, GameConfig>>,

    // --- game state (the score is persisted by Stage 4B's callback; Stage 5A stamps the
    //     entry's queued state here, so `entry` is now `mut`) ---
    // Authorization is the runtime operator-or-authority check in `queue_score_entry`
    // (against `config`), so the round no longer pins a single `authority`.
    #[account(
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
    )]
    pub round: Box<Account<'info, CompetitionRound>>,
    #[account(
        mut,
        seeds = [ENTRY_SEED, round.key().as_ref(), entry.player.as_ref()],
        bump = entry.bump,
        constraint = entry.round == round.key(),
        constraint = entry.flower_record == flower_record.key(),
        // GAP 1: refuse to re-queue an already-scored entry.
        constraint = !entry.scored @ SecretGardenError::EntryAlreadyScored,
        // Stage 5A: refuse to queue a second computation while one is in flight.
        constraint = !entry.score_queued @ SecretGardenError::ScoreAlreadyQueued,
    )]
    pub entry: Box<Account<'info, CompetitionEntry>>,
    /// The entry's flower; its encrypted genome is read in-place by the MPC.
    pub flower_record: Box<Account<'info, FlowerRecord>>,

    // --- arcium queue-side accounts ---
    #[account(
        init_if_needed,
        space = SIGN_PDA_ACCOUNT_LEN,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SCORE_ENTRY))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

/// Queues a `reveal_top3` computation for a Closed, fully-scored round. Authority signs.
#[queue_computation_accounts("reveal_top3", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct QueueRevealTop3<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Game config, read to enforce the pause kill-switch (Stage 5A: reveal is game
    /// progression, so it is halted while paused; check added here, logic unchanged).
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ SecretGardenError::GamePaused,
    )]
    pub config: Box<Account<'info, GameConfig>>,

    // Authorization is the runtime operator-or-authority check in `queue_reveal_top3`
    // (against `config`), so the round no longer pins a single `authority`.
    #[account(
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
    )]
    pub round: Box<Account<'info, CompetitionRound>>,

    // --- arcium queue-side accounts ---
    #[account(
        init_if_needed,
        space = SIGN_PDA_ACCOUNT_LEN,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_TOP3))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

/// Callback context for `score_entry`. The writable `entry` + `round` (in that order,
/// matching `queue_score_entry`'s registration) are persisted by the callback.
#[callback_accounts("score_entry_v2")]
#[derive(Accounts)]
pub struct ScoreEntryV2Callback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SCORE_ENTRY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint.
    pub instructions_sysvar: UncheckedAccount<'info>,

    #[account(mut)]
    pub entry: Box<Account<'info, CompetitionEntry>>,
    #[account(mut, constraint = entry.round == round.key())]
    pub round: Box<Account<'info, CompetitionRound>>,
}

/// Callback context for `reveal_top3`. The writable `round` receives the winners; the
/// round's entry accounts arrive as `remaining_accounts` (slot order) for slot→pubkey
/// resolution.
#[callback_accounts("reveal_top3")]
#[derive(Accounts)]
pub struct RevealTop3Callback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_TOP3))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint.
    pub instructions_sysvar: UncheckedAccount<'info>,

    #[account(mut)]
    pub round: Box<Account<'info, CompetitionRound>>,
}

/// Emitted by the Stage 4A `score_entry` callback stub once a score verifies.
#[event]
pub struct ScoreComputedEvent {
    /// The encrypted score ciphertext (1 scalar * 32 bytes).
    pub ciphertext: [u8; 32],
    /// The MXE nonce (little-endian u128).
    pub nonce: [u8; 16],
}

/// Emitted by the Stage 4A `reveal_top3` callback stub. The winners are public.
#[event]
pub struct Top3RevealedEvent {
    pub entry_index_1: u16,
    pub score_1: u8,
    pub entry_index_2: u16,
    pub score_2: u8,
    pub entry_index_3: u16,
    pub score_3: u8,
}

// ---------------------------------------------------------------------------
// Private Hint: Arcium account contexts (mirror the scoring contexts).
// ---------------------------------------------------------------------------

/// Registers the `private_hint` computation definition. Restricted to `config.authority`.
#[init_computation_definition_accounts("private_hint", authority)]
#[derive(Accounts)]
pub struct InitPrivateHintCompDef<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ SecretGardenError::NotAuthority,
    )]
    pub config: Account<'info, GameConfig>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by the arcium program. Not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by the arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

/// Queues a `private_hint` computation. The `player` signs and funds; they may only check a
/// flower they OWN that is NOT Locked (mid-breed), against the current OPEN round. Only one
/// round can be Open at a time (enforced by `open_round`), so `status == OPEN` uniquely
/// identifies the current round — no separate `current_round` match is needed.
#[queue_computation_accounts("private_hint", player)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct QueuePrivateHint<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    /// The round to check against — it must be the current OPEN round. `NoActiveRound`
    /// (rather than a silent no-op) if it is Closed/Finalized. Self-referential seeds prove
    /// it is a genuine `CompetitionRound` PDA.
    #[account(
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
        constraint = round.status == ROUND_STATUS_OPEN @ SecretGardenError::NoActiveRound,
    )]
    pub round: Box<Account<'info, CompetitionRound>>,

    /// The player's own flower. Its encrypted genome is read in-place by the MPC (never
    /// supplied by the caller). Must be owned by the signer and not Locked — a hint is
    /// checkable for Active OR Submitted flowers, just not one that is mid-breed.
    #[account(
        constraint = flower.owner == player.key() @ SecretGardenError::FlowerNotOwned,
        constraint = flower.status != FLOWER_STATUS_LOCKED @ SecretGardenError::FlowerNotActive,
    )]
    pub flower: Box<Account<'info, FlowerRecord>>,

    /// The single overwritable per-player hint account. `init_if_needed`: created on the
    /// first request, reused (overwritten) on every later one.
    #[account(
        init_if_needed,
        payer = player,
        space = 8 + HintResult::INIT_SPACE,
        seeds = [HINT_SEED, player.key().as_ref()],
        bump,
    )]
    pub hint_result: Box<Account<'info, HintResult>>,

    // --- arcium queue-side accounts (mirror QueueScoreEntry) ---
    #[account(
        init_if_needed,
        space = SIGN_PDA_ACCOUNT_LEN,
        payer = player,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_PRIVATE_HINT))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

/// Callback context for `private_hint`. The single writable `hint_result` (registered in
/// `queue_private_hint`'s `callback_ix`) receives the sealed bitmask. Self-referential seeds
/// bind it to its stored `player`, so the callback can only write the correct PDA.
#[callback_accounts("private_hint")]
#[derive(Accounts)]
pub struct PrivateHintCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_PRIVATE_HINT))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint.
    pub instructions_sysvar: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [HINT_SEED, hint_result.player.as_ref()],
        bump = hint_result.bump,
    )]
    pub hint_result: Box<Account<'info, HintResult>>,
}

/// Emitted by `private_hint_callback` when a hint is sealed and ready. Carries no secret
/// data — only the player + round so a client can react (the bitmask stays encrypted).
#[event]
pub struct HintComputedEvent {
    pub player: Pubkey,
    pub round_id: u64,
}
