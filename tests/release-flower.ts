/**
 * Secret Garden Protocol — `release_flower` (release-to-ACTIVE) + the breeding-laundering fix.
 *
 * `submit_entry` flips a flower to SUBMITTED and nothing ever flipped it back, so a
 * competed flower was permanently unusable — not breedable, not deletable, not
 * re-submittable — while still occupying its collection slot. `release_flower` returns it
 * to ACTIVE, but ONLY once its round is FINALIZED: while the round is Open or Closed its
 * entry can still be scored and revealed, so a flower must not be pulled back out.
 *
 * COMPANION FIX, NOT COVERED HERE: the old `start_breeding` parent guards were
 * `status != LOCKED`, which admitted a SUBMITTED parent, and `breed_callback`
 * unconditionally writes both parents back to ACTIVE — so breeding mid-round laundered a
 * Submitted flower into an Active one regardless of round state, bypassing this
 * instruction's round gate entirely. The guards are now `status == ACTIVE`.
 *
 * That guard CANNOT be tested under bankrun, for the reason `hardening.ts` and
 * `private-hint.ts` already document for the other Arcium queue instructions: Anchor
 * deserializes every account (owner/discriminator checks included) before it evaluates any
 * explicit `constraint =`, and `start_breeding`'s Arcium cluster accounts (mxe, mempool,
 * cluster, comp-def, …) do not exist in bankrun — so the transaction aborts with
 * `AccountNotInitialized` (0xbc4) long before the parent guards are reached. The fix is
 * proven on a live cluster instead, by `scripts/release-flower-devnet-test.mjs`, which
 * submits a real `start_breeding` naming a SUBMITTED flower and asserts the on-chain
 * `FlowerNotActive` rejection (both parent slots), then asserts it SUCCEEDS after release.
 *
 * What IS covered here is `release_flower` end to end: the round gate, every remaining
 * constraint, and the fact that a released flower is closeable and re-submittable again.
 */
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { assert } from "chai";
import { Harness, FIXED_UNIX_TS } from "./harness.ts";

// --- token-lock helpers for submit_entry's freeze (design doc §B site table) -------------
// `master_edition` is a Metaplex PDA, so Anchor cannot resolve it and accountsStrict needs it
// spelled out. For a never-minted flower it is never read -- the freeze helper returns on the
// mint's emptiness first -- but it is derived properly so these call sites stay correct when
// the flower IS minted.
const SG_MPL = new anchor.web3.PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const sgMintAuth = (h: Harness) =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("mint_auth")], h.program.programId)[0];
// The token account address for a flower's (possibly non-existent) mint. Must be a REAL
// derived address, not a placeholder: `flower_token` is `mut` now, and the program account
// itself can never satisfy that -- Solana demotes the invoked program to read-only, which
// surfaces as ConstraintMut rather than anything mentioning executability.
const SG_ATA_PROG = new anchor.web3.PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SG_TOKEN_PROG = new anchor.web3.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const sgFlowerToken = (flower: anchor.web3.PublicKey, owner: anchor.web3.PublicKey, h: Harness) => {
  const mint = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("flower_mint"), flower.toBuffer()], h.program.programId)[0];
  return anchor.web3.PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SG_TOKEN_PROG.toBuffer(), mint.toBuffer()], SG_ATA_PROG)[0];
};
const sgMasterEdition = (flower: anchor.web3.PublicKey, h: Harness) => {
  const mint = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("flower_mint"), flower.toBuffer()], h.program.programId)[0];
  return anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), SG_MPL.toBuffer(), mint.toBuffer(), Buffer.from("edition")],
    SG_MPL)[0];
};
import { seedSgd, feeAccounts, ixSetSgdMint, SGD_MINT, ENTRY_FEE_SGD, openRoundAccounts } from "./sgd.ts";

const { PublicKey } = anchor.web3;
type PK = anchor.web3.PublicKey;

// Anchor custom error codes (6000 + variant index); see programs/.../error.rs.
const ERR_GAME_PAUSED = "0x1772"; // 6002
const ERR_FLOWER_NOT_ACTIVE = "0x177b"; // 6011
const ERR_STARTER_NOT_DELETABLE = "0x1793"; // 6035
const ERR_ROUND_NOT_FINALIZED = "0x17a4"; // 6052
const ERR_FLOWER_NOT_SUBMITTED = "0x17a5"; // 6053
const ERR_ENTRY_MISMATCH = "0x17a6"; // 6054
const ERR_ENTRY_ALREADY_RELEASED = "0x17a7"; // 6055

const ENTRY_STATUS_SUBMITTED = 0;
const ENTRY_STATUS_RELEASED = 1;

const FLOWER_STATUS_ACTIVE = 0;
const FLOWER_STATUS_SUBMITTED = 2;
const GENOME_STATUS_ENCRYPTED = 1;
const HYBRID_VISUAL_SPECIES_ID = 255;
const GENOME_COMMITMENT_LEN = 32;
const ENCRYPTED_GENOME_LEN = 320;
const ENCRYPTION_METADATA_LEN = 16;

/** The hybrid PDA index used for the crafted flowers (starters occupy 0..=5). */
const HYBRID_INDEX = 6;
const HYBRID_INDEX_2 = 7;

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

const ixSubmit = (h: Harness, player: PK, roundId: number, flower: PK) => {
  const round = h.roundPda(roundId);
  return h.program.methods
    .submitEntry()
    .accountsStrict({
      player,
      config: h.configPda(),
      profile: h.profilePda(player),
      round,
      flowerRecord: flower,
      flowerMint: anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("flower_mint"), flower.toBuffer()],
        h.program.programId,
      )[0],
      flowerToken: sgFlowerToken(flower, player, h),
      previousProfile: h.profilePda(player),
      newProfile: h.profilePda(player),
      masterEdition: sgMasterEdition(flower, h),
      mintAuthority: sgMintAuth(h),
      tokenMetadataProgram: new anchor.web3.PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"),
      entry: h.entryPda(round, player),
      systemProgram: h.systemProgram(),
      ...feeAccounts(h, player, roundId),
    })
    .instruction();
};

const ixClose = (h: Harness, authority: PK, roundId: number) =>
  h.program.methods
    .closeRound()
    .accountsStrict({ authority, config: h.configPda(), round: h.roundPda(roundId) })
    .instruction();

const ixFinalize = (h: Harness, authority: PK, roundId: number) =>
  h.program.methods
    .finalizeRound()
    .accountsStrict({ authority, config: h.configPda(), round: h.roundPda(roundId) })
    .instruction();

/**
 * `submitter` is used ONLY to derive the entry PDA — release is permissionless now, so it
 * is not a signer and does not appear in the account list. Whoever signs the transaction
 * is irrelevant to the program.
 */
const ixRelease = (
  h: Harness,
  submitter: PK,
  roundId: number,
  flower: PK,
  entryOverride?: PK,
) => {
  const round = h.roundPda(roundId);
  return h.program.methods
    .releaseFlower()
    .accountsStrict({
      config: h.configPda(),
      round,
      entry: entryOverride ?? h.entryPda(round, submitter),
      flower,
      flowerMint: anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("flower_mint"), flower.toBuffer()],
        h.program.programId,
      )[0],
      flowerToken: h.program.programId,
      previousProfile: h.profilePda(submitter),
      newProfile: h.profilePda(submitter),
    })
    .instruction();
};

const ixCloseFlower = (h: Harness, owner: PK, flower: PK) =>
  h.program.methods
    .closeFlower()
    .accountsStrict({
      owner,
      config: h.configPda(),
      profile: h.profilePda(owner),
      flower,
      flowerMint: anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("flower_mint"), flower.toBuffer()],
        h.program.programId,
      )[0],
    })
    .instruction();

// --- account crafting --------------------------------------------------------

/**
 * Writes a hybrid `FlowerRecord` (ENCRYPTED genome, so `release_flower`/`close_flower`
 * accept it) directly into the bank. Breeding needs a live MPC cluster, so a crafted
 * account is the established way to get a hybrid into a bankrun test.
 */
async function craftHybrid(
  h: Harness,
  owner: PK,
  index: number,
  status = FLOWER_STATUS_ACTIVE,
): Promise<PK> {
  const pda = h.flowerPda(owner, index);
  const data = await h.program.coder.accounts.encode("flowerRecord", {
    owner,
    flowerIndex: index,
    visualSpeciesId: HYBRID_VISUAL_SPECIES_ID,
    generation: 1,
    rarity: 2,
    stability: 95,
    revealedTraitMask: 0,
    parentA: h.flowerPda(owner, 0),
    parentB: h.flowerPda(owner, 1),
    genomeStatus: GENOME_STATUS_ENCRYPTED,
    sourceExperiment: PublicKey.default,
    status,
    createdAt: new BN(FIXED_UNIX_TS),
    bump: 255,
    genomeCommitment: Array.from(new Uint8Array(GENOME_COMMITMENT_LEN)),
    encryptedGenome: Array.from(new Uint8Array(ENCRYPTED_GENOME_LEN)),
    encryptionMetadata: Array.from(new Uint8Array(ENCRYPTION_METADATA_LEN)),
  });
  h.context.setAccount(pda, {
    lamports: 5_000_000,
    data: Buffer.from(data),
    owner: h.program.programId,
    executable: false,
    rentEpoch: 0,
  });
  return pda;
}

/**
 * Fresh validator, config, profile, six starters, one crafted ACTIVE hybrid, round 1 open
 * and the hybrid submitted into it. Returns everything the cases need.
 */
async function bootstrapSubmitted(): Promise<{
  h: Harness;
  authority: anchor.web3.Keypair;
  hybrid: PK;
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
  const hybrid = await craftHybrid(h, authority.publicKey, HYBRID_INDEX);

  let r = await h.send([await ixOpenRound(h, authority.publicKey, 0)], [authority]);
  assert.isNull(r.result, `open_round (setup) failed: ${r.result}`);
  r = await h.send([await ixSubmit(h, authority.publicKey, 1, hybrid)], [authority]);
  assert.isNull(r.result, `submit_entry (setup) failed: ${r.result}`);

  const f = await h.program.account.flowerRecord.fetch(hybrid);
  assert.equal(f.status, FLOWER_STATUS_SUBMITTED, "setup: flower should be Submitted");
  return { h, authority, hybrid };
}

describe("release_flower — returning a competed flower to the collection", () => {
  describe("the round gate", () => {
    it("REJECTS release while the round is still Open", async () => {
      const { h, authority, hybrid } = await bootstrapSubmitted();
      const r = await h.send(
        [await ixRelease(h, authority.publicKey, 1, hybrid)],
        [authority],
      );
      assert.include(r.result ?? "", ERR_ROUND_NOT_FINALIZED);
      const f = await h.program.account.flowerRecord.fetch(hybrid);
      assert.equal(f.status, FLOWER_STATUS_SUBMITTED, "flower must stay Submitted");
    });

    it("REJECTS release while the round is Closed but not yet Finalized", async () => {
      const { h, authority, hybrid } = await bootstrapSubmitted();
      let r = await h.send([await ixClose(h, authority.publicKey, 1)], [authority]);
      assert.isNull(r.result, `close_round failed: ${r.result}`);

      r = await h.send([await ixRelease(h, authority.publicKey, 1, hybrid)], [authority]);
      assert.include(r.result ?? "", ERR_ROUND_NOT_FINALIZED);
      const f = await h.program.account.flowerRecord.fetch(hybrid);
      assert.equal(f.status, FLOWER_STATUS_SUBMITTED, "flower must stay Submitted");
    });

    it("SUCCEEDS once the round is Finalized, and leaves total_flowers alone", async () => {
      const { h, authority, hybrid } = await bootstrapSubmitted();
      await h.send([await ixClose(h, authority.publicKey, 1)], [authority]);
      await h.send([await ixFinalize(h, authority.publicKey, 1)], [authority]);

      const before = await h.program.account.playerProfile.fetch(
        h.profilePda(authority.publicKey),
      );
      const r = await h.send(
        [await ixRelease(h, authority.publicKey, 1, hybrid)],
        [authority],
      );
      assert.isNull(r.result, `release_flower failed: ${r.result}`);

      const f = await h.program.account.flowerRecord.fetch(hybrid);
      assert.equal(f.status, FLOWER_STATUS_ACTIVE, "flower should be Active again");

      // submit_entry never decremented total_flowers, so release must not either —
      // otherwise the `total_flowers - STARTER_COUNT == live hybrids` invariant breaks.
      const after = await h.program.account.playerProfile.fetch(
        h.profilePda(authority.publicKey),
      );
      assert.equal(after.totalFlowers, before.totalFlowers);
    });

    it("leaves the round's entry record intact (history is not rewritten)", async () => {
      const { h, authority, hybrid } = await bootstrapSubmitted();
      await h.send([await ixClose(h, authority.publicKey, 1)], [authority]);
      await h.send([await ixFinalize(h, authority.publicKey, 1)], [authority]);
      await h.send([await ixRelease(h, authority.publicKey, 1, hybrid)], [authority]);

      const entry = await h.program.account.competitionEntry.fetch(
        h.entryPda(h.roundPda(1), authority.publicKey),
      );
      assert.isTrue(entry.flowerRecord.equals(hybrid));
      assert.isTrue(entry.round.equals(h.roundPda(1)));
    });
  });

  describe("the remaining guards", () => {
    it("REJECTS a second release (the entry's release right is spent)", async () => {
      const { h, authority, hybrid } = await bootstrapSubmitted();
      await h.send([await ixClose(h, authority.publicKey, 1)], [authority]);
      await h.send([await ixFinalize(h, authority.publicKey, 1)], [authority]);
      let r = await h.send([await ixRelease(h, authority.publicKey, 1, hybrid)], [authority]);
      assert.isNull(r.result, `first release failed: ${r.result}`);

      // Both the entry flag and the flower status now disqualify a replay; `entry` is
      // declared before `flower`, so Anchor surfaces the entry's error first.
      r = await h.send([await ixRelease(h, authority.publicKey, 1, hybrid)], [authority]);
      assert.include(r.result ?? "", ERR_ENTRY_ALREADY_RELEASED);
    });

    it("REJECTS a flower that is not Submitted, even with an unspent entry", async () => {
      const { h, authority, hybrid } = await bootstrapSubmitted();
      await h.send([await ixClose(h, authority.publicKey, 1)], [authority]);
      await h.send([await ixFinalize(h, authority.publicKey, 1)], [authority]);

      // Force ONLY the flower back to Active, leaving the entry unspent, so the flower
      // status guard is the sole thing that can reject.
      await craftHybrid(h, authority.publicKey, HYBRID_INDEX, FLOWER_STATUS_ACTIVE);
      assert.equal(
        (await h.program.account.competitionEntry.fetch(
          h.entryPda(h.roundPda(1), authority.publicKey),
        )).status,
        ENTRY_STATUS_SUBMITTED,
      );

      const r = await h.send([await ixRelease(h, authority.publicKey, 1, hybrid)], [authority]);
      assert.include(r.result ?? "", ERR_FLOWER_NOT_SUBMITTED);
    });

    it("REJECTS a flower that is not the one this entry submitted", async () => {
      const { h, authority, hybrid } = await bootstrapSubmitted();
      await h.send([await ixClose(h, authority.publicKey, 1)], [authority]);
      await h.send([await ixFinalize(h, authority.publicKey, 1)], [authority]);

      // A DIFFERENT hybrid, owned by the same player and forced to Submitted, so every
      // other constraint passes and only the entry binding can reject it.
      const other = await craftHybrid(
        h,
        authority.publicKey,
        HYBRID_INDEX_2,
        FLOWER_STATUS_SUBMITTED,
      );
      const r = await h.send([await ixRelease(h, authority.publicKey, 1, other)], [authority]);
      assert.include(r.result ?? "", ERR_ENTRY_MISMATCH);
      assert.equal(
        (await h.program.account.flowerRecord.fetch(other)).status,
        FLOWER_STATUS_SUBMITTED,
      );
      assert.equal(
        (await h.program.account.flowerRecord.fetch(hybrid)).status,
        FLOWER_STATUS_SUBMITTED,
      );
    });

    it("PERMISSIONLESS: a stranger CAN release someone else's finalized flower", async () => {
      // Was "REJECTS a caller who is not the flower's owner". The rule inverted deliberately:
      // requiring the owner to sign AND deriving the entry from that signer is precisely the
      // pair that strands a Submitted flower once it changes hands. Release now asks whether
      // the round is finalized, not who is asking.
      const { h, authority, hybrid } = await bootstrapSubmitted();
      await h.send([await ixClose(h, authority.publicKey, 1)], [authority]);
      await h.send([await ixFinalize(h, authority.publicKey, 1)], [authority]);

      const stranger = h.fundedKeypair();
      const r = await h.send(
        [await ixRelease(h, authority.publicKey, 1, hybrid)],
        [stranger], // signs the transaction; is not an account the program sees
      );
      assert.isNull(r.result, `a stranger must be able to release: ${r.result}`);
      assert.equal(
        (await h.program.account.flowerRecord.fetch(hybrid)).status,
        FLOWER_STATUS_ACTIVE,
        "the flower must come back Active",
      );
      // ...and the flower still belongs to its owner. Release returns control, never takes it.
      assert.equal(
        (await h.program.account.flowerRecord.fetch(hybrid)).owner.toBase58(),
        authority.publicKey.toBase58(),
      );
    });

    it("PERMISSIONLESS: the release still burns the entry, so a stranger cannot replay it", async () => {
      const { h, authority, hybrid } = await bootstrapSubmitted();
      await h.send([await ixClose(h, authority.publicKey, 1)], [authority]);
      await h.send([await ixFinalize(h, authority.publicKey, 1)], [authority]);

      const stranger = h.fundedKeypair();
      assert.isNull(
        (await h.send([await ixRelease(h, authority.publicKey, 1, hybrid)], [stranger])).result,
      );
      const second = await h.send(
        [await ixRelease(h, authority.publicKey, 1, hybrid)],
        [stranger],
      );
      assert.isNotNull(second.result, "one-shot must survive going permissionless");
    });

    it("REJECTS a starter flower (starters keep the STARTER genome status)", async () => {
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
      await h.send([await ixOpenRound(h, authority.publicKey, 0)], [authority]);

      const starter = h.flowerPda(authority.publicKey, 0);
      let r = await h.send([await ixSubmit(h, authority.publicKey, 1, starter)], [authority]);
      assert.isNull(r.result, `submit_entry (starter) failed: ${r.result}`);
      await h.send([await ixClose(h, authority.publicKey, 1)], [authority]);
      await h.send([await ixFinalize(h, authority.publicKey, 1)], [authority]);

      r = await h.send([await ixRelease(h, authority.publicKey, 1, starter)], [authority]);
      assert.include(r.result ?? "", ERR_STARTER_NOT_DELETABLE);
    });

    it("REJECTS release while the game is paused", async () => {
      const { h, authority, hybrid } = await bootstrapSubmitted();
      await h.send([await ixClose(h, authority.publicKey, 1)], [authority]);
      await h.send([await ixFinalize(h, authority.publicKey, 1)], [authority]);
      await h.setPaused(true);

      const r = await h.send([await ixRelease(h, authority.publicKey, 1, hybrid)], [authority]);
      assert.include(r.result ?? "", ERR_GAME_PAUSED);
    });
  });

  describe("what the released flower can do again", () => {
    it("is closeable (close_flower) only AFTER release, and the slot is then freed", async () => {
      const { h, authority, hybrid } = await bootstrapSubmitted();
      await h.send([await ixClose(h, authority.publicKey, 1)], [authority]);
      await h.send([await ixFinalize(h, authority.publicKey, 1)], [authority]);

      // Still Submitted: close_flower requires ACTIVE.
      let r = await h.send([await ixCloseFlower(h, authority.publicKey, hybrid)], [authority]);
      assert.include(r.result ?? "", ERR_FLOWER_NOT_ACTIVE);

      await h.send([await ixRelease(h, authority.publicKey, 1, hybrid)], [authority]);

      const before = await h.program.account.playerProfile.fetch(
        h.profilePda(authority.publicKey),
      );
      r = await h.send([await ixCloseFlower(h, authority.publicKey, hybrid)], [authority]);
      assert.isNull(r.result, `close_flower after release failed: ${r.result}`);
      assert.isNull(await h.client.getAccount(hybrid), "flower account should be closed");

      const after = await h.program.account.playerProfile.fetch(
        h.profilePda(authority.publicKey),
      );
      assert.equal(after.totalFlowers, before.totalFlowers - 1);
    });

    it("is re-submittable in a later round", async () => {
      const { h, authority, hybrid } = await bootstrapSubmitted();
      await h.send([await ixClose(h, authority.publicKey, 1)], [authority]);
      await h.send([await ixFinalize(h, authority.publicKey, 1)], [authority]);
      await h.send([await ixRelease(h, authority.publicKey, 1, hybrid)], [authority]);

      let r = await h.send([await ixOpenRound(h, authority.publicKey, 1)], [authority]);
      assert.isNull(r.result, `open_round 2 failed: ${r.result}`);
      r = await h.send([await ixSubmit(h, authority.publicKey, 2, hybrid)], [authority]);
      assert.isNull(r.result, `re-submit failed: ${r.result}`);

      const f = await h.program.account.flowerRecord.fetch(hybrid);
      assert.equal(f.status, FLOWER_STATUS_SUBMITTED);
    });
  });

  describe("release is one-shot per entry (finalized-entry replay)", () => {
    it("marks the entry Released, and a released entry cannot release again", async () => {
      const { h, authority, hybrid } = await bootstrapSubmitted();
      const entryPda = h.entryPda(h.roundPda(1), authority.publicKey);
      assert.equal(
        (await h.program.account.competitionEntry.fetch(entryPda)).status,
        ENTRY_STATUS_SUBMITTED,
      );

      await h.send([await ixClose(h, authority.publicKey, 1)], [authority]);
      await h.send([await ixFinalize(h, authority.publicKey, 1)], [authority]);
      const r = await h.send(
        [await ixRelease(h, authority.publicKey, 1, hybrid)],
        [authority],
      );
      assert.isNull(r.result, `release failed: ${r.result}`);
      assert.equal(
        (await h.program.account.competitionEntry.fetch(entryPda)).status,
        ENTRY_STATUS_RELEASED,
        "release must burn the entry's release right",
      );
    });

    /**
     * THE REPLAY. Round 1's entry stays valid forever once round 1 is Finalized, so without
     * the one-shot flag a player could: release from round 1, re-submit the same flower into
     * the live round 2, then present round 1's entry AGAIN to yank the flower straight back
     * out of round 2 — defeating the round gate. From there `close_flower` would delete a
     * flower round 2 still has to score, and round 2 could never reach
     * `scored_count == participant_count`, so it could never be revealed.
     */
    it("REJECTS replaying a finalized round's entry to pull the flower out of the LIVE next round", async () => {
      const { h, authority, hybrid } = await bootstrapSubmitted();
      await h.send([await ixClose(h, authority.publicKey, 1)], [authority]);
      await h.send([await ixFinalize(h, authority.publicKey, 1)], [authority]);
      await h.send([await ixRelease(h, authority.publicKey, 1, hybrid)], [authority]);

      // Round 2 opens and the (legitimately released) flower is entered into it.
      await h.send([await ixOpenRound(h, authority.publicKey, 1)], [authority]);
      let r = await h.send([await ixSubmit(h, authority.publicKey, 2, hybrid)], [authority]);
      assert.isNull(r.result, `re-submit failed: ${r.result}`);
      assert.equal(
        (await h.program.account.flowerRecord.fetch(hybrid)).status,
        FLOWER_STATUS_SUBMITTED,
      );

      // Replay round 1's entry. Every OTHER constraint passes here — round 1 is Finalized,
      // the entry names this flower, and the flower really is Submitted — so the one-shot
      // entry flag is the only thing standing between this and a bypassed round gate.
      r = await h.send([await ixRelease(h, authority.publicKey, 1, hybrid)], [authority]);
      assert.include(r.result ?? "", ERR_ENTRY_ALREADY_RELEASED);
      assert.equal(
        (await h.program.account.flowerRecord.fetch(hybrid)).status,
        FLOWER_STATUS_SUBMITTED,
        "the flower must stay Submitted to the live round 2",
      );

      // And it therefore remains undeletable while round 2 still needs it.
      r = await h.send([await ixCloseFlower(h, authority.publicKey, hybrid)], [authority]);
      assert.include(r.result ?? "", ERR_FLOWER_NOT_ACTIVE);
    });

    it("still allows the LIVE round's own entry to release once that round finalizes", async () => {
      const { h, authority, hybrid } = await bootstrapSubmitted();
      await h.send([await ixClose(h, authority.publicKey, 1)], [authority]);
      await h.send([await ixFinalize(h, authority.publicKey, 1)], [authority]);
      await h.send([await ixRelease(h, authority.publicKey, 1, hybrid)], [authority]);

      await h.send([await ixOpenRound(h, authority.publicKey, 1)], [authority]);
      await h.send([await ixSubmit(h, authority.publicKey, 2, hybrid)], [authority]);
      await h.send([await ixClose(h, authority.publicKey, 2)], [authority]);
      await h.send([await ixFinalize(h, authority.publicKey, 2)], [authority]);

      const r = await h.send([await ixRelease(h, authority.publicKey, 2, hybrid)], [authority]);
      assert.isNull(r.result, `release from round 2 failed: ${r.result}`);
      assert.equal(
        (await h.program.account.flowerRecord.fetch(hybrid)).status,
        FLOWER_STATUS_ACTIVE,
      );
    });
  });
});
