/**
 * Secret Garden Protocol — Stage 1 integration tests.
 *
 * Covers the three instructions (initialize_config, create_profile, claim_starters)
 * and the three accounts (GameConfig, PlayerProfile, FlowerRecord) end to end against
 * an in-process Solana banks server. Tests share one server and run top-to-bottom.
 */
import * as anchor from "@anchor-lang/core";
import { assert, expect } from "chai";
import { Harness, FIXED_UNIX_TS } from "./harness.ts";

const { PublicKey } = anchor.web3;

// Mirror of the program's compile-time SPECIES table — see programs/.../constants.rs.
const TRAIT_PETAL_COLOR = 1 << 0;
const TRAIT_PETAL_SHAPE = 1 << 1;
const TRAIT_LEAF_FORM = 1 << 2;
const TRAIT_GLOW = 1 << 3;
const TRAIT_SCENT = 1 << 4;
const TRAIT_HEIGHT = 1 << 5;
const BASELINE = TRAIT_PETAL_COLOR | TRAIT_PETAL_SHAPE | TRAIT_LEAF_FORM;

const EXPECTED_SPECIES = [
  { visualSpeciesId: 0, rarity: 2, mask: BASELINE | TRAIT_GLOW }, // Lunar Silkweave
  { visualSpeciesId: 1, rarity: 3, mask: BASELINE | TRAIT_GLOW }, // Specter Orchid
  { visualSpeciesId: 2, rarity: 2, mask: BASELINE | TRAIT_SCENT }, // Heart's Echo
  { visualSpeciesId: 3, rarity: 4, mask: BASELINE | TRAIT_GLOW | TRAIT_HEIGHT }, // Dawnlotus Prime
  { visualSpeciesId: 4, rarity: 1, mask: BASELINE }, // Velvet Snapdragon
  { visualSpeciesId: 5, rarity: 3, mask: BASELINE | TRAIT_SCENT }, // Twilight Lavendula
] as const;

// Anchor custom error codes (6000 + variant index).
const ERR_GAME_PAUSED = "0x1772"; // 6002
const ERR_STARTERS_CLAIMED = "0x1774"; // 6004

describe("secret-garden (Stage 1)", () => {
  let h: Harness;
  let owner: anchor.web3.Keypair;

  before(async () => {
    h = await Harness.create();
    owner = h.payer;
  });

  describe("initialize_config", () => {
    it("initializes the singleton GameConfig", async () => {
      const ix = await h.program.methods
        .initializeConfig()
        .accountsStrict({
          authority: owner.publicKey,
          config: h.configPda(),
          systemProgram: h.systemProgram(),
        })
        .instruction();

      const { result } = await h.send([ix], [owner]);
      assert.isNull(result, `init failed: ${result}`);

      const cfg = await h.program.account.gameConfig.fetch(h.configPda());
      expect(cfg.authority.equals(owner.publicKey)).to.equal(true);
      expect(cfg.paused).to.equal(false);
      expect(cfg.currentRound.toNumber()).to.equal(0);
      expect(cfg.starterCount).to.equal(6);
      expect(cfg.version).to.equal(1);
      expect(cfg.bump).to.be.greaterThan(0);
    });

    it("rejects a second initialization", async () => {
      const ix = await h.program.methods
        .initializeConfig()
        .accountsStrict({
          authority: owner.publicKey,
          config: h.configPda(),
          systemProgram: h.systemProgram(),
        })
        .instruction();

      const { result } = await h.send([ix], [owner]);
      assert.isNotNull(result, "second initialize_config should fail");
    });
  });

  describe("create_profile", () => {
    const buildCreateProfile = async (signer: anchor.web3.PublicKey) =>
      h.program.methods
        .createProfile()
        .accountsStrict({
          owner: signer,
          config: h.configPda(),
          profile: h.profilePda(signer),
          systemProgram: h.systemProgram(),
        })
        .instruction();

    it("creates the caller's PlayerProfile", async () => {
      const ix = await buildCreateProfile(owner.publicKey);
      const { result } = await h.send([ix], [owner]);
      assert.isNull(result, `create_profile failed: ${result}`);

      const profile = await h.program.account.playerProfile.fetch(
        h.profilePda(owner.publicKey),
      );
      expect(profile.owner.equals(owner.publicKey)).to.equal(true);
      expect(profile.starterClaimed).to.equal(false);
      expect(profile.totalFlowers).to.equal(0);
      expect(profile.totalCrosses).to.equal(0);
      expect(profile.dailyAttempts).to.equal(0);
      expect(profile.finalSubmissions).to.equal(0);
      expect(profile.createdAt.toNumber()).to.equal(FIXED_UNIX_TS);
      expect(profile.bump).to.be.greaterThan(0);
    });

    it("rejects a second profile for the same wallet", async () => {
      const ix = await buildCreateProfile(owner.publicKey);
      const { result } = await h.send([ix], [owner]);
      assert.isNotNull(result, "duplicate create_profile should fail");
    });

    it("rejects profile creation while the game is paused", async () => {
      const stranger = h.fundedKeypair();
      await h.setPaused(true);
      try {
        const ix = await buildCreateProfile(stranger.publicKey);
        const { result } = await h.send([ix], [stranger]);
        assert.isNotNull(result, "create_profile should fail while paused");
        expect(result).to.contain(ERR_GAME_PAUSED);
        // The profile must not have been created.
        const acc = await h.client.getAccount(h.profilePda(stranger.publicKey));
        assert.isNull(acc, "no profile should exist for the paused attempt");
      } finally {
        await h.setPaused(false);
      }
    });
  });

  describe("claim_starters", () => {
    const buildClaim = async (signer: anchor.web3.PublicKey) => {
      const flowers = h.flowerPdas(signer);
      return h.program.methods
        .claimStarters()
        .accountsStrict({
          owner: signer,
          config: h.configPda(),
          profile: h.profilePda(signer),
          flower0: flowers[0],
          flower1: flowers[1],
          flower2: flowers[2],
          flower3: flowers[3],
          flower4: flowers[4],
          flower5: flowers[5],
          systemProgram: h.systemProgram(),
        })
        .instruction();
    };

    it("mints six starter flowers in a single transaction (one approval)", async () => {
      const ix = await buildClaim(owner.publicKey);
      // A single instruction in a single transaction signed once == one wallet approval.
      const { result } = await h.send([ix], [owner]);
      assert.isNull(result, `claim_starters failed: ${result}`);

      const profile = await h.program.account.playerProfile.fetch(
        h.profilePda(owner.publicKey),
      );
      expect(profile.starterClaimed).to.equal(true);
      expect(profile.totalFlowers).to.equal(6);

      for (let i = 0; i < 6; i++) {
        const flower = await h.program.account.flowerRecord.fetch(
          h.flowerPda(owner.publicKey, i),
        );
        const expected = EXPECTED_SPECIES[i];
        expect(flower.owner.equals(owner.publicKey)).to.equal(true);
        expect(flower.flowerIndex).to.equal(i);
        expect(flower.visualSpeciesId).to.equal(expected.visualSpeciesId);
        expect(flower.generation).to.equal(0);
        expect(flower.rarity).to.equal(expected.rarity);
        expect(flower.stability).to.equal(100);
        expect(flower.revealedTraitMask).to.equal(expected.mask);
        expect(flower.parentA.equals(PublicKey.default)).to.equal(true);
        expect(flower.parentB.equals(PublicKey.default)).to.equal(true);
        expect(flower.genomeStatus).to.equal(0); // Starter
        expect(flower.sourceExperiment.equals(PublicKey.default)).to.equal(
          true,
        );
        expect(flower.status).to.equal(0); // Active
        expect(flower.createdAt.toNumber()).to.equal(FIXED_UNIX_TS);
        expect(flower.bump).to.be.greaterThan(0);
      }
    });

    it("rejects a second claim", async () => {
      // A double-claim is prevented two ways: the `starter_claimed` guard and the
      // fact that the six flower PDAs already exist. Anchor runs account
      // initialization before custom `constraint` checks, so the first failure on a
      // real re-claim is the flower PDA collision ("account already in use"); either
      // way the transaction is rejected and no state changes.
      const ix = await buildClaim(owner.publicKey);
      const { result } = await h.send([ix], [owner]);
      assert.isNotNull(result, "second claim_starters should fail");

      // Profile remains claimed exactly once with its six flowers.
      const profile = await h.program.account.playerProfile.fetch(
        h.profilePda(owner.publicKey),
      );
      expect(profile.starterClaimed).to.equal(true);
      expect(profile.totalFlowers).to.equal(6);
    });

    it("enforces the StartersAlreadyClaimed guard when reached", async () => {
      // Directly exercise the semantic guard: with the `starter_claimed` flag set but
      // no flower-PDA collision in the way, claim_starters must fail with the explicit
      // StartersAlreadyClaimed error (6004 / 0x1774) rather than a generic failure.
      const fresh = h.fundedKeypair();
      const profilePda = h.profilePda(fresh.publicKey);
      await h.send(
        [
          await h.program.methods
            .createProfile()
            .accountsStrict({
              owner: fresh.publicKey,
              config: h.configPda(),
              profile: profilePda,
              systemProgram: h.systemProgram(),
            })
            .instruction(),
        ],
        [fresh],
      );
      // Flip PlayerProfile.starter_claimed (offset 8 discriminator + 32 owner = 40).
      const acc = await h.client.getAccount(profilePda);
      assert.isNotNull(acc);
      const data = Buffer.from(acc!.data);
      data[40] = 1;
      h.context.setAccount(profilePda, { ...acc!, data });

      const flowers = h.flowerPdas(fresh.publicKey);
      const ix = await h.program.methods
        .claimStarters()
        .accountsStrict({
          owner: fresh.publicKey,
          config: h.configPda(),
          profile: profilePda,
          flower0: flowers[0],
          flower1: flowers[1],
          flower2: flowers[2],
          flower3: flowers[3],
          flower4: flowers[4],
          flower5: flowers[5],
          systemProgram: h.systemProgram(),
        })
        .instruction();
      const { result } = await h.send([ix], [fresh]);
      assert.isNotNull(result, "claim should fail when already claimed");
      expect(result).to.contain(ERR_STARTERS_CLAIMED);
    });

    it("re-derives and reloads all six flowers (browser refresh)", async () => {
      // Simulate a fresh client that only knows the wallet: derive every PDA and read.
      const pdas = h.flowerPdas(owner.publicKey);
      expect(pdas).to.have.lengthOf(6);

      const reloaded = await Promise.all(
        pdas.map((pda) => h.program.account.flowerRecord.fetch(pda)),
      );
      expect(reloaded).to.have.lengthOf(6);
      reloaded.forEach((flower, i) => {
        expect(flower.flowerIndex).to.equal(i);
        expect(flower.visualSpeciesId).to.equal(
          EXPECTED_SPECIES[i].visualSpeciesId,
        );
        expect(flower.rarity).to.equal(EXPECTED_SPECIES[i].rarity);
        expect(flower.revealedTraitMask).to.equal(EXPECTED_SPECIES[i].mask);
        expect(flower.owner.equals(owner.publicKey)).to.equal(true);
      });
    });
  });
});
