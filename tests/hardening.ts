/**
 * Secret Garden Protocol — Stage 5A hardening tests (bankrun).
 *
 * Deterministic, in-process coverage for the three Stage 5A additions:
 *   - set_paused + the pause kill-switch reaching the non-Arcium player instructions;
 *   - reclaim_dead_offspring (rent reclaim for a dead breeding's offspring);
 *   - cancel_stuck_score (permissionless reset of a stuck scoring computation).
 *
 * The three Arcium queue instructions (start_breeding, queue_score_entry,
 * queue_reveal_top3) cannot have their pause gate exercised under bankrun: Anchor
 * deserializes ALL accounts before running the `config.paused` constraint, and their
 * cluster accounts (mxe, mempool, …) do not exist in bankrun, so deserialization fails
 * before the pause check is reached. Their pause rejection is verified in the live suites
 * (breeding.ts / scoring.ts) where those accounts exist. The `config` account is the
 * SECOND account in each of those contexts, so the gate is structurally identical to the
 * instructions covered here.
 */
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { assert, expect } from "chai";
import { Harness, FIXED_UNIX_TS } from "./harness.ts";

const { PublicKey } = anchor.web3;
type PK = anchor.web3.PublicKey;

// Anchor custom error codes (6000 + variant index); see programs/.../error.rs.
const ERR_NOT_AUTHORITY = "0x1771"; // 6001
const ERR_GAME_PAUSED = "0x1772"; // 6002
const ERR_ENTRY_ALREADY_SCORED = "0x1783"; // 6019
const ERR_SCORE_NOT_QUEUED = "0x1786"; // 6022
const ERR_SCORE_NOT_YET_TIMED_OUT = "0x1787"; // 6023
const ERR_EXPERIMENT_NOT_DEAD = "0x1788"; // 6024
const ERR_OFFSPRING_NOT_RECLAIMABLE = "0x1789"; // 6025
const ERR_INVALID_RENT_DESTINATION = "0x178a"; // 6026

// Mirror of on-chain constants (programs/.../constants.rs).
const SCORE_TIMEOUT_SECONDS = 600;
const FLOWER_STATUS_ACTIVE = 0;
const FLOWER_STATUS_LOCKED = 1;
const EXPERIMENT_STATUS_COMPLETED = 2;
const EXPERIMENT_STATUS_FAILED = 3;
const EXPERIMENT_STATUS_EXPIRED = 4;
const GENOME_STATUS_ENCRYPTED = 1;
const HYBRID_VISUAL_SPECIES_ID = 255;
const ENCRYPTED_GENOME_LEN = 320;
const GENOME_COMMITMENT_LEN = 32;
const ENCRYPTION_METADATA_LEN = 16;
const ENTRY_SCORE_LEN = 32;
const ENTRY_SCORE_NONCE_LEN = 16;

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

const ixOpenRound = (h: Harness, authority: PK, currentRound: number) =>
  h.program.methods
    .openRound()
    .accountsStrict({
      authority,
      config: h.configPda(),
      previousRound: currentRound > 0 ? h.roundPda(currentRound) : null,
      round: h.roundPda(currentRound + 1),
      systemProgram: h.systemProgram(),
    })
    .instruction();

const ixSetPaused = (h: Harness, authority: PK, value: boolean) =>
  h.program.methods
    .setPaused(value)
    .accountsStrict({ authority, config: h.configPda() })
    .instruction();

const ixSubmit = (h: Harness, player: PK, roundId: number, flowerIndex: number) => {
  const round = h.roundPda(roundId);
  return h.program.methods
    .submitEntry()
    .accountsStrict({
      player,
      config: h.configPda(),
      profile: h.profilePda(player),
      round,
      flowerRecord: h.flowerPda(player, flowerIndex),
      entry: h.entryPda(round, player),
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

function setAccount(h: Harness, pda: PK, data: Buffer, lamports = 5_000_000): void {
  h.context.setAccount(pda, {
    lamports,
    data,
    owner: h.program.programId,
    executable: false,
    rentEpoch: 0,
  });
}

async function craftExperiment(
  h: Harness,
  pda: PK,
  owner: PK,
  status: number,
  resultFlower: PK,
): Promise<void> {
  const data = await h.program.coder.accounts.encode("experiment", {
    owner,
    parentA: PublicKey.default,
    parentB: PublicKey.default,
    computationOffset: new BN(1),
    status,
    resultFlower,
    createdAt: new BN(FIXED_UNIX_TS),
    updatedAt: new BN(FIXED_UNIX_TS),
    errorCode: 0,
    callbackProcessed: true,
    bump: 255,
  });
  setAccount(h, pda, Buffer.from(data));
}

async function craftOffspring(
  h: Harness,
  pda: PK,
  owner: PK,
  status: number,
  sourceExperiment: PK,
  lamports: number,
): Promise<void> {
  const data = await h.program.coder.accounts.encode("flowerRecord", {
    owner,
    flowerIndex: 6,
    visualSpeciesId: HYBRID_VISUAL_SPECIES_ID,
    generation: 1,
    rarity: 0,
    stability: 90,
    revealedTraitMask: 0,
    parentA: PublicKey.default,
    parentB: PublicKey.default,
    genomeStatus: GENOME_STATUS_ENCRYPTED,
    sourceExperiment,
    status,
    createdAt: new BN(FIXED_UNIX_TS),
    bump: 255,
    genomeCommitment: Array.from(new Uint8Array(GENOME_COMMITMENT_LEN)),
    encryptedGenome: Array.from(new Uint8Array(ENCRYPTED_GENOME_LEN)),
    encryptionMetadata: Array.from(new Uint8Array(ENCRYPTION_METADATA_LEN)),
  });
  setAccount(h, pda, Buffer.from(data), lamports);
}

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

// =============================================================================

describe("secret-garden Stage 5A: hardening (bankrun)", () => {
  describe("set_paused", () => {
    it("rejects a non-authority signer", async () => {
      const h = await Harness.create();
      const authority = h.payer;
      await h.send([await ixInitConfig(h, authority.publicKey)], [authority]);

      const stranger = h.fundedKeypair();
      const r = await h.send(
        [await ixSetPaused(h, stranger.publicKey, true)],
        [stranger],
      );
      assert.isNotNull(r.result, "non-authority set_paused should fail");
      expect(r.result).to.contain(ERR_NOT_AUTHORITY);

      // Pause flag unchanged.
      const cfg = await h.program.account.gameConfig.fetch(h.configPda());
      expect(cfg.paused).to.equal(false);
    });

    it("lets the authority toggle paused on and off", async () => {
      const h = await Harness.create();
      const authority = h.payer;
      await h.send([await ixInitConfig(h, authority.publicKey)], [authority]);

      let r = await h.send([await ixSetPaused(h, authority.publicKey, true)], [authority]);
      assert.isNull(r.result, `set_paused(true) failed: ${r.result}`);
      expect((await h.program.account.gameConfig.fetch(h.configPda())).paused).to.equal(true);

      r = await h.send([await ixSetPaused(h, authority.publicKey, false)], [authority]);
      assert.isNull(r.result, `set_paused(false) failed: ${r.result}`);
      expect((await h.program.account.gameConfig.fetch(h.configPda())).paused).to.equal(false);
    });
  });

  describe("pause kill-switch (non-Arcium player instructions)", () => {
    let h: Harness;
    let authority: anchor.web3.Keypair;
    let unclaimed: anchor.web3.Keypair; // has a profile, has NOT claimed starters
    let fresh: anchor.web3.Keypair; // has no profile

    before(async () => {
      h = await Harness.create();
      authority = h.payer;
      await h.send([await ixInitConfig(h, authority.publicKey)], [authority]);
      // Authority gets a profile + starters and opens a round — all while UNPAUSED.
      await h.send([await ixCreateProfile(h, authority.publicKey)], [authority]);
      await h.send([await ixClaimStarters(h, authority.publicKey)], [authority]);
      await h.send([await ixOpenRound(h, authority.publicKey, 0)], [authority]);

      // A second wallet with a profile but no starters yet (to test claim_starters).
      unclaimed = h.fundedKeypair();
      await h.send([await ixCreateProfile(h, unclaimed.publicKey)], [unclaimed]);

      fresh = h.fundedKeypair();

      // Engage the kill-switch via the REAL instruction.
      const r = await h.send([await ixSetPaused(h, authority.publicKey, true)], [authority]);
      assert.isNull(r.result, `set_paused(true) failed: ${r.result}`);
    });

    const expectPaused = (label: string, result: string | null) => {
      assert.isNotNull(result, `${label} should fail while paused`);
      expect(result, `${label} should fail with GamePaused`).to.contain(ERR_GAME_PAUSED);
    };

    it("create_profile is rejected", async () => {
      const r = await h.send([await ixCreateProfile(h, fresh.publicKey)], [fresh]);
      expectPaused("create_profile", r.result);
    });

    it("claim_starters is rejected", async () => {
      const r = await h.send([await ixClaimStarters(h, unclaimed.publicKey)], [unclaimed]);
      expectPaused("claim_starters", r.result);
    });

    it("submit_entry is rejected", async () => {
      const r = await h.send([await ixSubmit(h, authority.publicKey, 1, 0)], [authority]);
      expectPaused("submit_entry", r.result);
    });

    it("recovery still works while paused: cancel_stuck_score", async () => {
      // A stuck, timed-out entry must be recoverable even with the game paused.
      const round = PublicKey.unique();
      const entry = h.entryPda(round, authority.publicKey);
      await craftEntry(h, entry, round, authority.publicKey, false, true, FIXED_UNIX_TS);

      const caller = h.fundedKeypair();
      const r = await h.send(
        [
          await h.program.methods
            .cancelStuckScore()
            .accountsStrict({ caller: caller.publicKey, entry })
            .instruction(),
        ],
        [caller],
        FIXED_UNIX_TS + SCORE_TIMEOUT_SECONDS,
      );
      assert.isNull(r.result, `cancel_stuck_score should succeed while paused: ${r.result}`);
      expect((await h.program.account.competitionEntry.fetch(entry)).scoreQueued).to.equal(false);
    });

    it("recovery still works while paused: reclaim_dead_offspring", async () => {
      const expPda = experimentPda(h, authority.publicKey, 0);
      const offspring = h.flowerPda(authority.publicKey, 6);
      await craftExperiment(h, expPda, authority.publicKey, EXPERIMENT_STATUS_FAILED, offspring);
      await craftOffspring(h, offspring, authority.publicKey, FLOWER_STATUS_LOCKED, expPda, 3_000_000);

      const caller = h.fundedKeypair();
      const r = await h.send(
        [
          await h.program.methods
            .reclaimDeadOffspring()
            .accountsStrict({
              caller: caller.publicKey,
              experiment: expPda,
              offspring,
              ownerRecipient: authority.publicKey,
            })
            .instruction(),
        ],
        [caller],
      );
      assert.isNull(r.result, `reclaim should succeed while paused: ${r.result}`);
    });
  });

  describe("cancel_stuck_score", () => {
    let h: Harness;
    let player: anchor.web3.Keypair;

    const cancelIx = async (caller: PK, entry: PK) =>
      h.program.methods
        .cancelStuckScore()
        .accountsStrict({ caller, entry })
        .instruction();

    before(async () => {
      h = await Harness.create();
      player = h.payer;
      await h.send([await ixInitConfig(h, player.publicKey)], [player]);
    });

    it("fails before the timeout has elapsed", async () => {
      const round = PublicKey.unique();
      const entry = h.entryPda(round, player.publicKey);
      await craftEntry(h, entry, round, player.publicKey, false, true, FIXED_UNIX_TS);

      const caller = h.fundedKeypair();
      const r = await h.send(
        [await cancelIx(caller.publicKey, entry)],
        [caller],
        FIXED_UNIX_TS + SCORE_TIMEOUT_SECONDS - 1,
      );
      assert.isNotNull(r.result, "cancel before timeout should fail");
      expect(r.result).to.contain(ERR_SCORE_NOT_YET_TIMED_OUT);
    });

    it("fails when the entry is not currently queued", async () => {
      const round = PublicKey.unique();
      const entry = h.entryPda(round, player.publicKey);
      // score_queued = false -> nothing in flight to reset.
      await craftEntry(h, entry, round, player.publicKey, false, false, FIXED_UNIX_TS);

      const caller = h.fundedKeypair();
      const r = await h.send(
        [await cancelIx(caller.publicKey, entry)],
        [caller],
        FIXED_UNIX_TS + SCORE_TIMEOUT_SECONDS,
      );
      assert.isNotNull(r.result, "cancel on a non-queued entry should fail");
      expect(r.result).to.contain(ERR_SCORE_NOT_QUEUED);
    });

    it("fails when the entry is already scored", async () => {
      const round = PublicKey.unique();
      const entry = h.entryPda(round, player.publicKey);
      await craftEntry(h, entry, round, player.publicKey, true, true, FIXED_UNIX_TS);

      const caller = h.fundedKeypair();
      const r = await h.send(
        [await cancelIx(caller.publicKey, entry)],
        [caller],
        FIXED_UNIX_TS + SCORE_TIMEOUT_SECONDS,
      );
      assert.isNotNull(r.result, "cancel on a scored entry should fail");
      expect(r.result).to.contain(ERR_ENTRY_ALREADY_SCORED);
    });

    it("succeeds after the timeout and leaves the entry re-queueable", async () => {
      const round = PublicKey.unique();
      const entry = h.entryPda(round, player.publicKey);
      await craftEntry(h, entry, round, player.publicKey, false, true, FIXED_UNIX_TS);

      const caller = h.fundedKeypair();
      const r = await h.send(
        [await cancelIx(caller.publicKey, entry)],
        [caller],
        FIXED_UNIX_TS + SCORE_TIMEOUT_SECONDS,
      );
      assert.isNull(r.result, `cancel after timeout failed: ${r.result}`);

      const e = await h.program.account.competitionEntry.fetch(entry);
      // Re-queueable: in-flight flag cleared, still unscored, no false scored-count effect.
      expect(e.scoreQueued).to.equal(false);
      expect(e.scored).to.equal(false);

      // A second cancel now fails — the in-flight flag is already cleared.
      const r2 = await h.send(
        [await cancelIx(caller.publicKey, entry)],
        [caller],
        FIXED_UNIX_TS + SCORE_TIMEOUT_SECONDS + 1,
      );
      assert.isNotNull(r2.result, "second cancel should fail");
      expect(r2.result).to.contain(ERR_SCORE_NOT_QUEUED);
    });
  });

  describe("reclaim_dead_offspring", () => {
    let h: Harness;
    let player: anchor.web3.Keypair;

    const reclaimIx = async (caller: PK, experiment: PK, offspring: PK, recipient: PK) =>
      h.program.methods
        .reclaimDeadOffspring()
        .accountsStrict({ caller, experiment, offspring, ownerRecipient: recipient })
        .instruction();

    before(async () => {
      h = await Harness.create();
      player = h.payer;
      await h.send([await ixInitConfig(h, player.publicKey)], [player]);
    });

    it("fails on a Completed experiment's offspring (not dead)", async () => {
      const expPda = experimentPda(h, player.publicKey, 10);
      const offspring = h.flowerPda(player.publicKey, 6);
      await craftExperiment(h, expPda, player.publicKey, EXPERIMENT_STATUS_COMPLETED, offspring);
      await craftOffspring(h, offspring, player.publicKey, FLOWER_STATUS_ACTIVE, expPda, 3_000_000);

      const caller = h.fundedKeypair();
      const r = await h.send(
        [await reclaimIx(caller.publicKey, expPda, offspring, player.publicKey)],
        [caller],
      );
      assert.isNotNull(r.result, "reclaim on a completed experiment should fail");
      expect(r.result).to.contain(ERR_EXPERIMENT_NOT_DEAD);
    });

    it("fails when the offspring is still Active (would-be successful result)", async () => {
      const expPda = experimentPda(h, player.publicKey, 11);
      const offspring = h.flowerPda(player.publicKey, 7);
      await craftExperiment(h, expPda, player.publicKey, EXPERIMENT_STATUS_FAILED, offspring);
      // Failed experiment but an ACTIVE offspring is not reclaimable.
      await craftOffspring(h, offspring, player.publicKey, FLOWER_STATUS_ACTIVE, expPda, 3_000_000);

      const caller = h.fundedKeypair();
      const r = await h.send(
        [await reclaimIx(caller.publicKey, expPda, offspring, player.publicKey)],
        [caller],
      );
      assert.isNotNull(r.result, "reclaim of an active offspring should fail");
      expect(r.result).to.contain(ERR_OFFSPRING_NOT_RECLAIMABLE);
    });

    it("fails when the rent destination is not the flower owner", async () => {
      const expPda = experimentPda(h, player.publicKey, 12);
      const offspring = h.flowerPda(player.publicKey, 8);
      await craftExperiment(h, expPda, player.publicKey, EXPERIMENT_STATUS_EXPIRED, offspring);
      await craftOffspring(h, offspring, player.publicKey, FLOWER_STATUS_LOCKED, expPda, 3_000_000);

      const caller = h.fundedKeypair();
      const r = await h.send(
        [await reclaimIx(caller.publicKey, expPda, offspring, PublicKey.unique())],
        [caller],
      );
      assert.isNotNull(r.result, "reclaim with wrong recipient should fail");
      expect(r.result).to.contain(ERR_INVALID_RENT_DESTINATION);
    });

    it("succeeds on a Failed experiment: rent returns to the owner; double-reclaim fails", async () => {
      const expPda = experimentPda(h, player.publicKey, 13);
      const offspring = h.flowerPda(player.publicKey, 9);
      const RENT = 3_000_000;
      await craftExperiment(h, expPda, player.publicKey, EXPERIMENT_STATUS_FAILED, offspring);
      await craftOffspring(h, offspring, player.publicKey, FLOWER_STATUS_LOCKED, expPda, RENT);

      // The caller is NOT the owner, so the owner pays no fee — its balance delta is
      // exactly the reclaimed rent.
      const caller = h.fundedKeypair();
      const ownerBefore = await h.client.getBalance(player.publicKey);

      const r = await h.send(
        [await reclaimIx(caller.publicKey, expPda, offspring, player.publicKey)],
        [caller],
      );
      assert.isNull(r.result, `reclaim should succeed: ${r.result}`);

      const ownerAfter = await h.client.getBalance(player.publicKey);
      expect((ownerAfter - ownerBefore).toString()).to.equal(RENT.toString());

      // The offspring account is closed (no lamports / not a live FlowerRecord).
      const acc = await h.client.getAccount(offspring);
      const closed = acc === null || acc.lamports === 0;
      expect(closed, "offspring account should be closed").to.equal(true);

      // Double-reclaim now fails because the offspring no longer exists.
      const caller2 = h.fundedKeypair();
      const r2 = await h.send(
        [await reclaimIx(caller2.publicKey, expPda, offspring, player.publicKey)],
        [caller2],
      );
      assert.isNotNull(r2.result, "double reclaim should fail");
    });
  });

  describe("open_round pause gate (Stage 5A patch)", () => {
    it("rejects open_round while paused, allows it once unpaused", async () => {
      const h = await Harness.create();
      const authority = h.payer;
      await h.send([await ixInitConfig(h, authority.publicKey)], [authority]);

      // Paused: starting a NEW competition round is blocked by the kill-switch.
      await h.send([await ixSetPaused(h, authority.publicKey, true)], [authority]);
      const paused = await h.send([await ixOpenRound(h, authority.publicKey, 0)], [authority]);
      assert.isNotNull(paused.result, "open_round should fail while paused");
      expect(paused.result).to.contain(ERR_GAME_PAUSED);
      // The round account must not have been created.
      expect(await h.client.getAccount(h.roundPda(1))).to.equal(null);

      // Unpaused: opening the round proceeds normally.
      await h.send([await ixSetPaused(h, authority.publicKey, false)], [authority]);
      const ok = await h.send([await ixOpenRound(h, authority.publicKey, 0)], [authority]);
      assert.isNull(ok.result, `open_round should succeed when unpaused: ${ok.result}`);
      const round = await h.program.account.competitionRound.fetch(h.roundPda(1));
      expect(round.status).to.equal(0); // ROUND_STATUS_OPEN
      expect(round.roundId.toNumber()).to.equal(1);
    });
  });
});
