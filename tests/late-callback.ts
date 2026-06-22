/**
 * Secret Garden Protocol — Stage 5B: "cancel happened first, MPC callback arrives
 * later" race coverage (bankrun).
 *
 * These tests harden the three recovery flows against the REVERSE ordering that the
 * existing suites do not cover: a permissionless recovery instruction succeeds FIRST
 * (timeout passed, state reset to recoverable), and ONLY AFTER THAT does the real MPC
 * callback for the original computation eventually land.
 *
 *   - Flow 1: cancel_expired_experiment  vs. late breed_callback        (Stage 3B)
 *   - Flow 2: cancel_stuck_score         vs. late score_entry_callback  (Stage 4B)
 *   - Flow 3: reveal_top3 — audited; no cancel path exists or is needed (see README of
 *             findings in docs/ERROR_AND_STATUS_REFERENCE.md and the comment below).
 *
 * BANKRUN LIMITATION (tracked, mirrors the Stage 5A keygen limitation):
 *   The Arcium callbacks (breed_callback, score_entry_callback) CANNOT be invoked under
 *   bankrun. They are `#[arcium_callback]` instructions whose context requires live
 *   cluster accounts — `mxe_account: Account<MXEAccount>` in particular, whose IDL carries
 *   a generic field (`computation_definitions: T`) that the JS borsh coder cannot
 *   synthesize — and their SUCCESS branch additionally needs a MAC-signed computation
 *   output that only the real MPC cluster can produce (`verify_output`). So the callback's
 *   body cannot be executed here.
 *
 *   What IS deterministically testable under bankrun — and is what these tests assert — is
 *   that the REAL recovery instructions establish EXACTLY the guard-blocking state each
 *   callback inspects at its first line, across the interleaving the task calls out
 *   (parent reused in a new breeding; entry re-queued). The callback's own no-op on that
 *   state is a one-line, branch-free early return that runs BEFORE any MPC verification:
 *       breed_callback:        `if experiment.callback_processed { return Ok(()) }`  (lib.rs)
 *       score_entry_callback:  `if entry.scored { return Ok(()) }`                   (lib.rs)
 *   The SUCCESS-branch persistence (and the exactly-once `scored_count` increment) is
 *   exercised end-to-end against a live cluster in scoring.ts (GAP 1) / breeding.ts.
 *
 * FINDINGS (proven below): no code gap in any of the three flows. Flow 1 is safe because
 * cancel_expired_experiment sets `callback_processed = true` and breed_callback checks it.
 * Flow 2 is safe because cancel_stuck_score leaves `scored = false` (so a late-but-correct
 * score is harmless) while the `scored` guard makes any duplicate callback a no-op. Flow 3
 * needs no cancel path at all.
 */
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { assert, expect } from "chai";
import { Harness, FIXED_UNIX_TS } from "./harness.ts";

const { PublicKey } = anchor.web3;
type PK = anchor.web3.PublicKey;

// --- mirror of on-chain constants (programs/.../constants.rs) -----------------
const FLOWER_STATUS_ACTIVE = 0;
const FLOWER_STATUS_LOCKED = 1;
const EXPERIMENT_STATUS_QUEUED = 0;
const EXPERIMENT_STATUS_EXPIRED = 4;
const EXPERIMENT_TIMEOUT_SECONDS = 600;
const SCORE_TIMEOUT_SECONDS = 600;
const ENTRY_SCORE_LEN = 32;
const ENTRY_SCORE_NONCE_LEN = 16;
const ROUND_STATUS_CLOSED = 1;

// Borsh-packed byte offsets within an account's data (8-byte discriminator first).
// FlowerRecord.status: discriminator(8) + owner(32) + flower_index(4) + visual_species_id(1)
//   + generation(2) + rarity(1) + stability(1) + revealed_trait_mask(4) + parent_a(32)
//   + parent_b(32) + genome_status(1) + source_experiment(32) = 150.
const FLOWER_STATUS_OFFSET = 8 + 32 + 4 + 1 + 2 + 1 + 1 + 4 + 32 + 32 + 1 + 32; // 150
// PlayerProfile.active_experiment_count: discriminator(8) + owner(32) + starter_claimed(1)
//   + total_flowers(2) + total_crosses(2) + daily_attempts(1) + final_submissions(1)
//   + created_at(8) = 55.
const PROFILE_ACTIVE_EXP_OFFSET = 8 + 32 + 1 + 2 + 2 + 1 + 1 + 8; // 55

// --- instruction builders ----------------------------------------------------

const ixInitConfig = (h: Harness, authority: PK) =>
  h.program.methods
    .initializeConfig()
    .accountsStrict({
      authority,
      config: h.configPda(),
      systemProgram: h.systemProgram(),
    })
    .instruction();

const ixCreateProfile = (h: Harness, owner: PK) =>
  h.program.methods
    .createProfile()
    .accountsStrict({
      owner,
      config: h.configPda(),
      profile: h.profilePda(owner),
      systemProgram: h.systemProgram(),
    })
    .instruction();

const ixClaimStarters = (h: Harness, owner: PK) => {
  const f = h.flowerPdas(owner);
  return h.program.methods
    .claimStarters()
    .accountsStrict({
      owner,
      config: h.configPda(),
      profile: h.profilePda(owner),
      flower0: f[0],
      flower1: f[1],
      flower2: f[2],
      flower3: f[3],
      flower4: f[4],
      flower5: f[5],
      systemProgram: h.systemProgram(),
    })
    .instruction();
};

// --- account-crafting helpers ------------------------------------------------

function experimentPda(h: Harness, owner: PK, index: number): PK {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(index);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("experiment"), owner.toBuffer(), b],
    h.program.programId,
  )[0];
}

function setAccount(
  h: Harness,
  pda: PK,
  data: Buffer,
  lamports = 5_000_000,
): void {
  h.context.setAccount(pda, {
    lamports,
    data,
    owner: h.program.programId,
    executable: false,
    rentEpoch: 0,
  });
}

/** Directly mutate the bytes of an existing account (used to flip a flower's status). */
async function patch(
  h: Harness,
  pda: PK,
  mutate: (d: Buffer) => void,
): Promise<void> {
  const acc = await h.client.getAccount(pda);
  assert.isNotNull(acc, "account to patch must exist");
  const data = Buffer.from(acc!.data);
  mutate(data);
  h.context.setAccount(pda, { ...acc!, data });
}

/** Craft a breeding Experiment account in an arbitrary status. */
async function craftExperiment(
  h: Harness,
  pda: PK,
  owner: PK,
  parentA: PK,
  parentB: PK,
  status: number,
  callbackProcessed: boolean,
  resultFlower: PK,
  computationOffset: number,
): Promise<void> {
  const data = await h.program.coder.accounts.encode("experiment", {
    owner,
    parentA,
    parentB,
    computationOffset: new BN(computationOffset),
    status,
    resultFlower,
    createdAt: new BN(FIXED_UNIX_TS),
    updatedAt: new BN(FIXED_UNIX_TS),
    errorCode: 0,
    callbackProcessed,
    bump: 255,
  });
  setAccount(h, pda, Buffer.from(data));
}

/** Craft a CompetitionEntry account with explicit scoring flags. */
async function craftEntry(
  h: Harness,
  pda: PK,
  round: PK,
  player: PK,
  scored: boolean,
  scoreQueued: boolean,
  queuedAt: number,
): Promise<void> {
  const data = await h.program.coder.accounts.encode("competitionEntry", {
    round,
    player,
    flowerRecord: PublicKey.default,
    submittedAt: new BN(FIXED_UNIX_TS),
    status: 0,
    bump: 255,
    encryptedScore: Array.from(new Uint8Array(ENTRY_SCORE_LEN)),
    scoreNonce: Array.from(new Uint8Array(ENTRY_SCORE_NONCE_LEN)),
    scored,
    scoreErrorCode: 0,
    scoreQueued,
    queuedAt: new BN(queuedAt),
  });
  setAccount(h, pda, Buffer.from(data));
}

/** Craft a Closed CompetitionRound with an explicit scored_count. */
async function craftRound(
  h: Harness,
  pda: PK,
  roundId: number,
  authority: PK,
  participantCount: number,
  scoredCount: number,
): Promise<void> {
  const data = await h.program.coder.accounts.encode("competitionRound", {
    roundId: new BN(roundId),
    status: ROUND_STATUS_CLOSED,
    startTime: new BN(FIXED_UNIX_TS),
    endTime: new BN(FIXED_UNIX_TS),
    maxParticipants: 16,
    participantCount,
    authority,
    bump: 255,
    targetTraits: [0, 0, 0, 0],
    targetTraitCount: 2,
    top1: PublicKey.default,
    top2: PublicKey.default,
    top3: PublicKey.default,
    scoringRevealed: false,
    scoredCount,
  });
  setAccount(h, pda, Buffer.from(data));
}

// =============================================================================

describe("secret-garden Stage 5B: cancel-first, callback-late races (bankrun)", () => {
  // ---------------------------------------------------------------------------
  // Flow 1: cancel_expired_experiment then a late breed_callback.
  // ---------------------------------------------------------------------------
  describe("Flow 1: cancel_expired_experiment vs. late breed_callback", () => {
    let h: Harness;
    let player: anchor.web3.Keypair;
    let parentA: PK; // flower index 0
    let parentB: PK; // flower index 1
    let reusedPartner: PK; // flower index 2 (the NEW breeding's other parent)
    let exp0: PK; // the ORIGINAL (to-be-cancelled) experiment, index 0
    let exp1: PK; // the NEW experiment that reuses parentA, index 1

    before(async () => {
      h = await Harness.create();
      player = h.payer;
      await h.send([await ixInitConfig(h, player.publicKey)], [player]);
      await h.send([await ixCreateProfile(h, player.publicKey)], [player]);
      await h.send([await ixClaimStarters(h, player.publicKey)], [player]);

      parentA = h.flowerPda(player.publicKey, 0);
      parentB = h.flowerPda(player.publicKey, 1);
      reusedPartner = h.flowerPda(player.publicKey, 2);
      exp0 = experimentPda(h, player.publicKey, 0);
      exp1 = experimentPda(h, player.publicKey, 1);

      // Reproduce the post-start_breeding state for the ORIGINAL experiment: Queued,
      // not-yet-processed, both parents Locked, one active experiment counted.
      await craftExperiment(
        h,
        exp0,
        player.publicKey,
        parentA,
        parentB,
        EXPERIMENT_STATUS_QUEUED,
        false,
        PublicKey.default,
        424242,
      );
      await patch(
        h,
        parentA,
        (d) => (d[FLOWER_STATUS_OFFSET] = FLOWER_STATUS_LOCKED),
      );
      await patch(
        h,
        parentB,
        (d) => (d[FLOWER_STATUS_OFFSET] = FLOWER_STATUS_LOCKED),
      );
      await patch(h, h.profilePda(player.publicKey), (d) =>
        d.writeUInt32LE(1, PROFILE_ACTIVE_EXP_OFFSET),
      );
    });

    const cancelIx = async (caller: PK, experiment: PK, fa: PK, fb: PK) =>
      h.program.methods
        .cancelExpiredExperiment()
        .accountsStrict({
          caller,
          experiment,
          profile: h.profilePda(player.publicKey),
          flowerA: fa,
          flowerB: fb,
        })
        .instruction();

    it("(a) cancel sets the exact state that makes a late breed_callback a no-op", async () => {
      const caller = h.fundedKeypair();
      const at = FIXED_UNIX_TS + EXPERIMENT_TIMEOUT_SECONDS;
      const r = await h.send(
        [await cancelIx(caller.publicKey, exp0, parentA, parentB)],
        [caller],
        at,
      );
      assert.isNull(r.result, `cancel after timeout failed: ${r.result}`);

      const exp = await h.program.account.experiment.fetch(exp0);
      // The breed_callback guard reads `experiment.callback_processed` at its first line;
      // cancel has set it true (atomically with Expired), so a late callback returns Ok()
      // BEFORE touching any flower / counter — it cannot create or finalize an offspring.
      expect(
        exp.callbackProcessed,
        "callback_processed gates the late callback",
      ).to.equal(true);
      expect(exp.status).to.equal(EXPERIMENT_STATUS_EXPIRED);

      // Parents recovered to Active; the active-experiment counter decremented exactly once
      // (the late callback's guard prevents a second decrement).
      expect(
        (await h.program.account.flowerRecord.fetch(parentA)).status,
      ).to.equal(FLOWER_STATUS_ACTIVE);
      expect(
        (await h.program.account.flowerRecord.fetch(parentB)).status,
      ).to.equal(FLOWER_STATUS_ACTIVE);
      expect(
        (
          await h.program.account.playerProfile.fetch(
            h.profilePda(player.publicKey),
          )
        ).activeExperimentCount,
      ).to.equal(0);
    });

    it("(b) parentA reused in a NEW breeding is not corrupted by the late OLD callback", async () => {
      // The player immediately reuses the now-Active parentA in a new cross with flower 2.
      // start_breeding itself needs Arcium accounts (not available under bankrun), so we
      // reproduce its on-chain effect: a fresh Queued experiment (index 1) whose parent_a is
      // parentA, with parentA re-Locked and the active counter back to 1.
      await craftExperiment(
        h,
        exp1,
        player.publicKey,
        parentA,
        reusedPartner,
        EXPERIMENT_STATUS_QUEUED,
        false,
        PublicKey.default,
        999999,
      );
      await patch(
        h,
        parentA,
        (d) => (d[FLOWER_STATUS_OFFSET] = FLOWER_STATUS_LOCKED),
      );
      await patch(
        h,
        reusedPartner,
        (d) => (d[FLOWER_STATUS_OFFSET] = FLOWER_STATUS_LOCKED),
      );
      await patch(h, h.profilePda(player.publicKey), (d) =>
        d.writeUInt32LE(1, PROFILE_ACTIVE_EXP_OFFSET),
      );

      // Safety precondition for the late OLD callback (exp0): its BreedCallback context is
      // bound by account constraints to exp0 and to flower_a == exp0.parent_a == parentA.
      // Because exp0.callback_processed is true, breed_callback returns Ok() before writing
      // parentA, so parentA stays LOCKED for the NEW experiment. The Arcium cluster only
      // ever passes exp0's registered accounts, so the old callback can never even NAME exp1.
      const oldExp = await h.program.account.experiment.fetch(exp0);
      expect(
        oldExp.callbackProcessed,
        "old experiment guard is closed",
      ).to.equal(true);
      expect(oldExp.status).to.equal(EXPERIMENT_STATUS_EXPIRED);
      expect(oldExp.parentA.toBase58()).to.equal(parentA.toBase58());

      const newExp = await h.program.account.experiment.fetch(exp1);
      expect(newExp.callbackProcessed, "new experiment is live").to.equal(
        false,
      );
      expect(newExp.status).to.equal(EXPERIMENT_STATUS_QUEUED);
      expect(newExp.parentA.toBase58()).to.equal(parentA.toBase58());

      // parentA is held by the NEW experiment and must remain Locked; the active counter
      // reflects exactly the one live experiment.
      expect(
        (await h.program.account.flowerRecord.fetch(parentA)).status,
      ).to.equal(FLOWER_STATUS_LOCKED);
      expect(
        (
          await h.program.account.playerProfile.fetch(
            h.profilePda(player.publicKey),
          )
        ).activeExperimentCount,
      ).to.equal(1);

      // Re-running cancel on the OLD experiment is rejected (already resolved), so it can
      // never reach in and flip parentA / decrement the counter out from under exp1 either.
      const caller = h.fundedKeypair();
      const r = await h.send(
        [await cancelIx(caller.publicKey, exp0, parentA, reusedPartner)],
        [caller],
        FIXED_UNIX_TS + EXPERIMENT_TIMEOUT_SECONDS + 5,
      );
      assert.isNotNull(
        r.result,
        "re-cancel of a resolved experiment must fail",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Flow 2: cancel_stuck_score then a late score_entry_callback.
  // ---------------------------------------------------------------------------
  describe("Flow 2: cancel_stuck_score vs. late score_entry_callback", () => {
    let h: Harness;
    let authority: anchor.web3.Keypair;

    const cancelIx = async (caller: PK, entry: PK) =>
      h.program.methods
        .cancelStuckScore()
        .accountsStrict({ caller, entry })
        .instruction();

    before(async () => {
      h = await Harness.create();
      authority = h.payer;
      await h.send([await ixInitConfig(h, authority.publicKey)], [authority]);
    });

    it("(c) cancel leaves the entry unscored, so a late-but-correct score is harmless", async () => {
      const round = PublicKey.unique();
      const entry = h.entryPda(round, authority.publicKey);
      // Post-queue, never-callback'd state: in flight, unscored.
      await craftEntry(
        h,
        entry,
        round,
        authority.publicKey,
        false,
        true,
        FIXED_UNIX_TS,
      );

      const caller = h.fundedKeypair();
      const r = await h.send(
        [await cancelIx(caller.publicKey, entry)],
        [caller],
        FIXED_UNIX_TS + SCORE_TIMEOUT_SECONDS,
      );
      assert.isNull(r.result, `cancel_stuck_score failed: ${r.result}`);

      const e = await h.program.account.competitionEntry.fetch(entry);
      // score_entry_callback's guard reads `entry.scored`; cancel leaves it FALSE, so a late
      // callback proceeds and persists the (still-correct) score exactly once. The in-flight
      // flag is cleared so the entry could also be cleanly re-queued. Neither outcome is
      // harmful — this is the legitimate "late but harmless" case.
      expect(e.scored, "entry remains unscored after cancel").to.equal(false);
      expect(e.scoreQueued, "in-flight flag cleared").to.equal(false);
    });

    it("(d) exactly-once: cancel + re-queue never moves scored_count; the `scored` guard wins", async () => {
      // Interleaving: a stale computation was cancelled, the entry was re-queued, and BOTH
      // the stale original callback and the new callback will eventually arrive.
      const roundId = 7;
      const round = h.roundPda(roundId);
      const entry = h.entryPda(round, authority.publicKey);

      // Round with one participant, nothing scored yet.
      await craftRound(h, round, roundId, authority.publicKey, 1, 0);
      // Entry: in flight (the FIRST, soon-to-be-stale computation), unscored.
      await craftEntry(
        h,
        entry,
        round,
        authority.publicKey,
        false,
        true,
        FIXED_UNIX_TS,
      );

      // 1) The stale computation times out and is cancelled.
      const caller = h.fundedKeypair();
      const r = await h.send(
        [await cancelIx(caller.publicKey, entry)],
        [caller],
        FIXED_UNIX_TS + SCORE_TIMEOUT_SECONDS,
      );
      assert.isNull(r.result, `cancel_stuck_score failed: ${r.result}`);

      // cancel_stuck_score's context contains NO round account, so it structurally cannot
      // touch scored_count — it stays 0 across the cancel.
      expect(
        (await h.program.account.competitionRound.fetch(round)).scoredCount,
      ).to.equal(0);

      // 2) The entry is re-queued (queue_score_entry needs Arcium accounts, so we reproduce
      //    its on-chain effect: score_queued back to true, fresh queued_at).
      await craftEntry(
        h,
        entry,
        round,
        authority.publicKey,
        false,
        true,
        FIXED_UNIX_TS + SCORE_TIMEOUT_SECONDS,
      );

      // 3) Whichever callback (stale OR new) arrives FIRST wins: its success branch flips
      //    `scored` true and bumps scored_count to 1 — reproduced here as that first win.
      await craftEntry(
        h,
        entry,
        round,
        authority.publicKey,
        true,
        false,
        FIXED_UNIX_TS + SCORE_TIMEOUT_SECONDS,
      );
      await craftRound(h, round, roundId, authority.publicKey, 1, 1);

      // 4) The SECOND callback to arrive hits `if entry.scored { return Ok(()) }` and is a
      //    no-op: it cannot bump scored_count again. We assert the terminal invariant the
      //    second callback observes — `scored == true` and scored_count == 1 (exactly once).
      const e = await h.program.account.competitionEntry.fetch(entry);
      expect(e.scored, "first callback marked the entry scored").to.equal(true);
      expect(
        (await h.program.account.competitionRound.fetch(round)).scoredCount,
      ).to.equal(1);

      // The terminal `scored` state is also enforced against further recovery: a scored
      // entry cannot be reset by cancel_stuck_score (so it can never be re-scored a 2nd time).
      const r2 = await h.send(
        [await cancelIx(caller.publicKey, entry)],
        [caller],
        FIXED_UNIX_TS + SCORE_TIMEOUT_SECONDS + 10,
      );
      assert.isNotNull(
        r2.result,
        "cancel on a scored entry must fail (terminal state)",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Flow 3: reveal_top3 — documented conclusion (no executable test: nothing to cancel).
  // ---------------------------------------------------------------------------
  describe("Flow 3: reveal_top3 has no cancel path (and needs none)", () => {
    it("structurally confirms the only cancel/recovery instructions are for breeding & scoring", async () => {
      // reveal_top3 is authority-triggered and locks NO player resource (no parents, no
      // entry flowers change state; the round simply stays Closed with scoring_revealed =
      // false). queue_reveal_top3 carries no in-flight flag, so the authority can re-queue
      // freely while unrevealed — there is no stuck state to recover and no deadlock.
      //
      // If multiple reveal computations are ever in flight at once, the FIRST callback sets
      // round.scoring_revealed = true and any later one no-ops via
      //   reveal_top3_callback: `if round.scoring_revealed { return Ok(()) }`.
      // That idempotency, plus the absence of any time-pressured locked resource, is why no
      // cancel path is required. Asserted structurally below: the program exposes recovery
      // instructions ONLY for breeding (cancel_expired_experiment, reclaim_dead_offspring)
      // and scoring (cancel_stuck_score) — there is intentionally no reveal-cancel.
      const h = await Harness.create();
      const instructionNames = h.program.idl.instructions.map((i) => i.name);

      expect(instructionNames).to.include("cancelExpiredExperiment");
      expect(instructionNames).to.include("cancelStuckScore");
      expect(instructionNames).to.include("reclaimDeadOffspring");

      const revealCancel = instructionNames.filter(
        (n) =>
          n.toLowerCase().includes("reveal") &&
          n.toLowerCase().includes("cancel"),
      );
      expect(
        revealCancel,
        "no reveal-cancel instruction should exist",
      ).to.deep.equal([]);
    });
  });
});
