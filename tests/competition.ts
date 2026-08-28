/**
 * Secret Garden Protocol — Stage 2 integration tests.
 *
 * Covers the competition-round lifecycle (open_round, submit_entry, close_round,
 * finalize_round), the CompetitionRound / CompetitionEntry accounts, and the
 * FlowerRecord.status transition Active -> Submitted. Runs against solana-bankrun, the
 * same in-process validator used in Stage 1.
 *
 * Each test bootstraps a fresh validator (config + one player with six claimed
 * flowers) so the cases are fully isolated and deterministic.
 */
import * as anchor from "@anchor-lang/core";
import { assert, expect } from "chai";
import { Harness, FIXED_UNIX_TS } from "./harness.ts";
import { seedSgd, feeAccounts, ixSetSgdMint, SGD_MINT, ENTRY_FEE_SGD, openRoundAccounts } from "./sgd.ts";

const { PublicKey } = anchor.web3;

// Anchor custom error codes (6000 + variant index); see programs/.../error.rs.
const ERR_NOT_AUTHORITY = "0x1771"; // 6001
const ERR_PREV_NOT_FINALIZED = "0x1776"; // 6006
const ERR_ROUND_NOT_OPEN = "0x1777"; // 6007
const ERR_ROUND_DEADLINE = "0x1778"; // 6008
const ERR_ROUND_FULL = "0x1779"; // 6009
const ERR_FLOWER_NOT_OWNED = "0x177a"; // 6010
const ERR_FLOWER_NOT_ACTIVE = "0x177b"; // 6011
const ERR_ROUND_NOT_CLOSED = "0x177c"; // 6012

// Mirror of on-chain constants (programs/.../constants.rs).
const SECONDS_PER_DAY = 86_400;
const ROUND_ANCHOR_UTC_SECONDS = 36_000; // 10:00 UTC
const MIN_ROUND_DURATION_SECONDS = 43_200; // 12h

/**
 * TS mirror of `open_round::round_end_time`. A round no longer ends a fixed 24h after it
 * opens: it ends at the next 10:00 UTC that is at least 12h out, which is what stops the
 * daily schedule drifting later every cycle. Kept as an independent transcription (not
 * imported from anywhere) so it witnesses the on-chain behaviour rather than restating it.
 */
function roundEndTime(now: number): number {
  const dayStart = now - ((now % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  let anchor = dayStart + ROUND_ANCHOR_UTC_SECONDS;
  if (anchor <= now) anchor += SECONDS_PER_DAY;
  if (anchor - now < MIN_ROUND_DURATION_SECONDS) anchor += SECONDS_PER_DAY;
  return anchor;
}
// What a round ACCEPTS — `open_round` writes this into `max_participants`. Deliberately
// distinct from the program's `MAX_PARTICIPANTS` (still 16), which is the reveal CIRCUIT's
// fixed slot width. The bracket decoupled the two: a round is now revealed as several
// shard reveals rather than one call, so acceptance is no longer bounded by circuit width.
const ROUND_CAPACITY = 221;
const FLOWER_STATUS_ACTIVE = 0;
const FLOWER_STATUS_SUBMITTED = 2;
const ROUND_STATUS_OPEN = 0;
const ROUND_STATUS_CLOSED = 1;
const ROUND_STATUS_FINALIZED = 2;

// Borsh-packed offsets into account data for direct (setAccount) manipulation in tests.
const ACCOUNT_DISCRIMINATOR = 8;
// FlowerRecord: owner is the first field.
const FLOWER_OWNER_OFFSET = ACCOUNT_DISCRIMINATOR;
// FlowerRecord.status sits after owner(32) flower_index(4) visual_species_id(1)
// generation(2) rarity(1) stability(1) revealed_trait_mask(4) parent_a(32)
// parent_b(32) genome_status(1) source_experiment(32) = 142 bytes of fields.
const FLOWER_STATUS_OFFSET =
  ACCOUNT_DISCRIMINATOR + 32 + 4 + 1 + 2 + 1 + 1 + 4 + 32 + 32 + 1 + 32;
// CompetitionRound.participant_count sits after round_id(8) status(1) start_time(8)
// end_time(8) max_participants(2).
const ROUND_PARTICIPANT_COUNT_OFFSET =
  ACCOUNT_DISCRIMINATOR + 8 + 1 + 8 + 8 + 2;

type PK = anchor.web3.PublicKey;

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
      ...openRoundAccounts(h, currentRound + 1),
    })
    .instruction();

const ixSubmit = (
  h: Harness,
  player: PK,
  roundId: number,
  flowerIndex: number,
) => {
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
      ...feeAccounts(h, player, roundId),
    })
    .instruction();
};

const ixClose = (h: Harness, authority: PK, roundId: number) =>
  h.program.methods
    .closeRound()
    .accountsStrict({
      authority,
      config: h.configPda(),
      round: h.roundPda(roundId),
    })
    .instruction();

const ixFinalize = (h: Harness, authority: PK, roundId: number) =>
  h.program.methods
    .finalizeRound()
    .accountsStrict({
      authority,
      config: h.configPda(),
      round: h.roundPda(roundId),
    })
    .instruction();

// --- setup helpers -----------------------------------------------------------

/** Fresh validator with config initialized and the payer holding six flowers. */
async function bootstrap(): Promise<{
  h: Harness;
  authority: anchor.web3.Keypair;
}> {
  const h = await Harness.create();
  const authority = h.payer;
  await h.send([await ixInitConfig(h, authority.publicKey)], [authority]);
  // $SGD: create the mint and fee balances FIRST (set_sgd_mint reads the mint account, so it
  // has to exist), then pin it. submit_entry charges a mandatory fee now, so no suite can
  // submit an entry without all of this in place.
  seedSgd(h, [authority.publicKey]);
  await h.send([await ixSetSgdMint(h, authority.publicKey)], [authority]);
  await h.send([await ixCreateProfile(h, authority.publicKey)], [authority]);
  await h.send([await ixClaimStarters(h, authority.publicKey)], [authority]);
  return { h, authority };
}

/** Bootstrap, then open round 1. */
async function bootstrapWithOpenRound(): Promise<{
  h: Harness;
  authority: anchor.web3.Keypair;
}> {
  const { h, authority } = await bootstrap();
  const r = await h.send(
    [await ixOpenRound(h, authority.publicKey, 0)],
    [authority],
  );
  assert.isNull(r.result, `open_round (setup) failed: ${r.result}`);
  return { h, authority };
}

/** Overwrite a single byte/region of an existing account (test scaffolding only). */
async function patchAccount(
  h: Harness,
  pda: PK,
  mutate: (data: Buffer) => void,
): Promise<void> {
  const acc = await h.client.getAccount(pda);
  assert.isNotNull(acc, "account to patch must exist");
  const data = Buffer.from(acc!.data);
  mutate(data);
  h.context.setAccount(pda, { ...acc!, data });
}

describe("secret-garden Stage 2: competition rounds", () => {
  describe("open_round", () => {
    it("succeeds for the authority and opens round 1", async () => {
      const { h, authority } = await bootstrap();
      const r = await h.send(
        [await ixOpenRound(h, authority.publicKey, 0)],
        [authority],
      );
      assert.isNull(r.result, `open_round failed: ${r.result}`);

      const round = await h.program.account.competitionRound.fetch(
        h.roundPda(1),
      );
      expect(round.roundId.toNumber()).to.equal(1);
      expect(round.status).to.equal(ROUND_STATUS_OPEN);
      expect(round.maxParticipants).to.equal(ROUND_CAPACITY);
      expect(round.participantCount).to.equal(0);
      expect(round.authority.equals(authority.publicKey)).to.equal(true);
      // end_time is snapped to the daily 10:00 UTC anchor, not start_time + 24h.
      expect(round.endTime.toNumber()).to.equal(roundEndTime(FIXED_UNIX_TS));
      expect(round.endTime.toNumber() % SECONDS_PER_DAY).to.equal(
        ROUND_ANCHOR_UTC_SECONDS,
      );
      expect(
        round.endTime.sub(round.startTime).toNumber(),
      ).to.be.at.least(MIN_ROUND_DURATION_SECONDS);

      const cfg = await h.program.account.gameConfig.fetch(h.configPda());
      expect(cfg.currentRound.toNumber()).to.equal(1);
    });

    it("fails for a non-authority signer", async () => {
      const { h } = await bootstrap();
      const stranger = h.fundedKeypair();
      const r = await h.send(
        [await ixOpenRound(h, stranger.publicKey, 0)],
        [stranger],
      );
      assert.isNotNull(r.result, "non-authority open_round should fail");
      expect(r.result).to.contain(ERR_NOT_AUTHORITY);
    });

    it("rejects a second open_round before the first is finalized", async () => {
      const { h, authority } = await bootstrapWithOpenRound();
      // Round 1 is Open (not Finalized); opening round 2 must be rejected.
      const r = await h.send(
        [await ixOpenRound(h, authority.publicKey, 1)],
        [authority],
      );
      assert.isNotNull(r.result, "second open_round should fail");
      expect(r.result).to.contain(ERR_PREV_NOT_FINALIZED);
    });
  });

  describe("submit_entry", () => {
    it("succeeds for an owned, Active flower in an Open round before the deadline", async () => {
      const { h, authority } = await bootstrapWithOpenRound();
      const round = h.roundPda(1);
      const r = await h.send(
        [await ixSubmit(h, authority.publicKey, 1, 0)],
        [authority],
      );
      assert.isNull(r.result, `submit_entry failed: ${r.result}`);

      const entry = await h.program.account.competitionEntry.fetch(
        h.entryPda(round, authority.publicKey),
      );
      expect(entry.round.equals(round)).to.equal(true);
      expect(entry.player.equals(authority.publicKey)).to.equal(true);
      expect(
        entry.flowerRecord.equals(h.flowerPda(authority.publicKey, 0)),
      ).to.equal(true);
      expect(entry.status).to.equal(0); // Submitted (only value in Stage 2)
      expect(entry.submittedAt.toNumber()).to.be.greaterThan(0);

      const flower = await h.program.account.flowerRecord.fetch(
        h.flowerPda(authority.publicKey, 0),
      );
      expect(flower.status).to.equal(FLOWER_STATUS_SUBMITTED);

      const roundAcc = await h.program.account.competitionRound.fetch(round);
      expect(roundAcc.participantCount).to.equal(1);

      const profile = await h.program.account.playerProfile.fetch(
        h.profilePda(authority.publicKey),
      );
      expect(profile.finalSubmissions).to.equal(1);
    });

    it("fails if the flower is not owned by the signer", async () => {
      const { h, authority } = await bootstrapWithOpenRound();
      // Reassign flower 0's owner to a random key so the signer no longer owns it.
      await patchAccount(h, h.flowerPda(authority.publicKey, 0), (data) => {
        PublicKey.unique().toBuffer().copy(data, FLOWER_OWNER_OFFSET);
      });
      const r = await h.send(
        [await ixSubmit(h, authority.publicKey, 1, 0)],
        [authority],
      );
      assert.isNotNull(r.result, "submit with unowned flower should fail");
      expect(r.result).to.contain(ERR_FLOWER_NOT_OWNED);
    });

    it("fails if the flower is not Active", async () => {
      const { h, authority } = await bootstrapWithOpenRound();
      // Mark flower 0 as already Submitted.
      await patchAccount(h, h.flowerPda(authority.publicKey, 0), (data) => {
        data[FLOWER_STATUS_OFFSET] = FLOWER_STATUS_SUBMITTED;
      });
      const r = await h.send(
        [await ixSubmit(h, authority.publicKey, 1, 0)],
        [authority],
      );
      assert.isNotNull(r.result, "submit with non-active flower should fail");
      expect(r.result).to.contain(ERR_FLOWER_NOT_ACTIVE);
    });

    it("fails if the round is not Open", async () => {
      const { h, authority } = await bootstrapWithOpenRound();
      await h.send([await ixClose(h, authority.publicKey, 1)], [authority]); // round -> Closed
      const r = await h.send(
        [await ixSubmit(h, authority.publicKey, 1, 0)],
        [authority],
      );
      assert.isNotNull(r.result, "submit into a closed round should fail");
      expect(r.result).to.contain(ERR_ROUND_NOT_OPEN);
    });

    it("fails after the round deadline has passed", async () => {
      const { h, authority } = await bootstrapWithOpenRound();
      // Round opened at FIXED_UNIX_TS; submit one second past its SNAPPED end_time.
      const afterDeadline = roundEndTime(FIXED_UNIX_TS) + 1;
      const r = await h.send(
        [await ixSubmit(h, authority.publicKey, 1, 0)],
        [authority],
        afterDeadline,
      );
      assert.isNotNull(r.result, "submit past the deadline should fail");
      expect(r.result).to.contain(ERR_ROUND_DEADLINE);
    });

    it("rejects a duplicate submission by the same wallet (duplicate entry PDA)", async () => {
      const { h, authority } = await bootstrapWithOpenRound();
      const first = await h.send(
        [await ixSubmit(h, authority.publicKey, 1, 0)],
        [authority],
      );
      assert.isNull(first.result, `first submit failed: ${first.result}`);
      // Second submission (different flower) collides on the (round, player) entry PDA.
      const second = await h.send(
        [await ixSubmit(h, authority.publicKey, 1, 1)],
        [authority],
      );
      assert.isNotNull(second.result, "duplicate submit should fail");
    });

    it("fails once participant_count reaches max_participants", async () => {
      const { h, authority } = await bootstrapWithOpenRound();
      // Practical testing: raise participant_count to the max via setAccount instead of
      // performing ROUND_CAPACITY real submissions. The on-chain guard is then exercised directly.
      await patchAccount(h, h.roundPda(1), (data) => {
        data.writeUInt16LE(ROUND_CAPACITY, ROUND_PARTICIPANT_COUNT_OFFSET);
      });
      const r = await h.send(
        [await ixSubmit(h, authority.publicKey, 1, 0)],
        [authority],
      );
      assert.isNotNull(r.result, "submit into a full round should fail");
      expect(r.result).to.contain(ERR_ROUND_FULL);
    });
  });

  describe("close_round", () => {
    it("fails for a non-authority signer", async () => {
      const { h } = await bootstrapWithOpenRound();
      const stranger = h.fundedKeypair();
      const r = await h.send(
        [await ixClose(h, stranger.publicKey, 1)],
        [stranger],
      );
      assert.isNotNull(r.result, "non-authority close should fail");
      expect(r.result).to.contain(ERR_NOT_AUTHORITY);
    });

    it("succeeds for the authority even before end_time (early close)", async () => {
      const { h, authority } = await bootstrapWithOpenRound();
      // Default clock is FIXED_UNIX_TS, well before end_time — early close is allowed.
      const r = await h.send(
        [await ixClose(h, authority.publicKey, 1)],
        [authority],
      );
      assert.isNull(r.result, `close_round failed: ${r.result}`);
      const round = await h.program.account.competitionRound.fetch(
        h.roundPda(1),
      );
      expect(round.status).to.equal(ROUND_STATUS_CLOSED);
    });

    it("fails if the round is already Closed", async () => {
      const { h, authority } = await bootstrapWithOpenRound();
      await h.send([await ixClose(h, authority.publicKey, 1)], [authority]);
      const r = await h.send(
        [await ixClose(h, authority.publicKey, 1)],
        [authority],
      );
      assert.isNotNull(r.result, "double close should fail");
      expect(r.result).to.contain(ERR_ROUND_NOT_OPEN);
    });
  });

  describe("finalize_round", () => {
    it("fails if the round is still Open", async () => {
      const { h, authority } = await bootstrapWithOpenRound();
      const r = await h.send(
        [await ixFinalize(h, authority.publicKey, 1)],
        [authority],
      );
      assert.isNotNull(r.result, "finalize of an open round should fail");
      expect(r.result).to.contain(ERR_ROUND_NOT_CLOSED);
    });

    it("succeeds once the round is Closed", async () => {
      const { h, authority } = await bootstrapWithOpenRound();
      await h.send([await ixClose(h, authority.publicKey, 1)], [authority]);
      const r = await h.send(
        [await ixFinalize(h, authority.publicKey, 1)],
        [authority],
      );
      assert.isNull(r.result, `finalize_round failed: ${r.result}`);
      const round = await h.program.account.competitionRound.fetch(
        h.roundPda(1),
      );
      expect(round.status).to.equal(ROUND_STATUS_FINALIZED);
    });

    it("fails if called twice", async () => {
      const { h, authority } = await bootstrapWithOpenRound();
      await h.send([await ixClose(h, authority.publicKey, 1)], [authority]);
      await h.send([await ixFinalize(h, authority.publicKey, 1)], [authority]);
      const r = await h.send(
        [await ixFinalize(h, authority.publicKey, 1)],
        [authority],
      );
      assert.isNotNull(r.result, "second finalize should fail");
      expect(r.result).to.contain(ERR_ROUND_NOT_CLOSED);
    });
  });

  describe("full happy path", () => {
    it("open -> submit -> close (early) -> finalize -> open round 2", async () => {
      const { h, authority } = await bootstrap();
      const auth = authority.publicKey;

      // Round 1
      assert.isNull(
        (await h.send([await ixOpenRound(h, auth, 0)], [authority])).result,
      );
      assert.isNull(
        (await h.send([await ixSubmit(h, auth, 1, 0)], [authority])).result,
      );

      const flower = await h.program.account.flowerRecord.fetch(
        h.flowerPda(auth, 0),
      );
      expect(flower.status).to.equal(FLOWER_STATUS_SUBMITTED);

      assert.isNull(
        (await h.send([await ixClose(h, auth, 1)], [authority])).result,
      );
      assert.isNull(
        (await h.send([await ixFinalize(h, auth, 1)], [authority])).result,
      );

      const round1 = await h.program.account.competitionRound.fetch(
        h.roundPda(1),
      );
      expect(round1.status).to.equal(ROUND_STATUS_FINALIZED);

      // Round 2 can now open (previous round is Finalized).
      const r2 = await h.send([await ixOpenRound(h, auth, 1)], [authority]);
      assert.isNull(r2.result, `open round 2 failed: ${r2.result}`);

      const round2 = await h.program.account.competitionRound.fetch(
        h.roundPda(2),
      );
      expect(round2.roundId.toNumber()).to.equal(2);
      expect(round2.status).to.equal(ROUND_STATUS_OPEN);

      const cfg = await h.program.account.gameConfig.fetch(h.configPda());
      expect(cfg.currentRound.toNumber()).to.equal(2);

      // Sanity: a flower index never used by FLOWER_STATUS_ACTIVE stays usable.
      const fresh = await h.program.account.flowerRecord.fetch(
        h.flowerPda(auth, 1),
      );
      expect(fresh.status).to.equal(FLOWER_STATUS_ACTIVE);
    });
  });
});
