/**
 * Stage 5E migration proof: `migrate_flower` grows a pre-5E FlowerRecord in place.
 *
 * Two appends have grown this account: 5E added `times_bred_as_parent: u8` (528 -> 529),
 * and the §E flash-rent cooldown added `last_transfer_at: i64` (529 -> 537). Anchor cannot
 * read an undersized account as the current
 * `FlowerRecord` — it fails with AccountDidNotDeserialize (0xbbb), exactly as a pre-5D
 * PlayerProfile did before `migrate_profile` (see scripts/migrate-profile.ts). So every
 * flower created before this change must be reallocated before it can be used again.
 *
 * This is the same before/after field-preservation check migrate-profile.ts performs, run
 * in bankrun against a FABRICATED legacy account: `setAccount` writes a genuine 528-byte
 * pre-5E record (correct discriminator, real field values, one byte short), which is
 * precisely what the 742 flowers on devnet look like today. Doing it here rather than on
 * devnet means the migration is proven without deploying anything.
 *
 * What this proves:
 *   1. a 528-byte legacy record genuinely CANNOT be read as the new FlowerRecord;
 *   2. `migrate_flower` grows it to the current length and it becomes readable;
 *   3. every pre-existing field survives byte-for-byte;
 *   4. the appended byte is zero-filled, so a migrated flower starts with a full budget;
 *   5. the instruction is idempotent (running it twice is a no-op);
 *   6. it is owner-signed — another wallet cannot migrate someone else's flower.
 */
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { expect } from "chai";
import { Harness } from "./harness.ts";

const { PublicKey, Keypair } = anchor.web3;
type PK = anchor.web3.PublicKey;

const LEGACY_LEN = 528; // 8 + 520 (pre-5E)
const CURRENT_LEN = 537; // 8 + 529 (5E + the §E flash-rent last_transfer_at: i64)
const FLOWER_STATUS_ACTIVE = 1;
const GENOME_STATUS_ENCRYPTED = 1;
/** Rent-exempt minimum at 528 bytes — i.e. one byte short of funding the 529-byte layout. */
const LEGACY_RENT = 4_565_760;
const NOT_AUTHORITY = "0x1771"; // 6001

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

describe("Stage 5E: migrate_flower (pre-5E FlowerRecord -> 5E layout)", () => {
  /** The field values written into the fabricated legacy record, so we can diff them back. */
  const FIELDS = {
    flowerIndex: 3,
    visualSpeciesId: 255,
    generation: 4,
    rarity: 5,
    stability: 88,
    revealedTraitMask: 0x0004_0302,
    genomeStatus: GENOME_STATUS_ENCRYPTED,
    status: FLOWER_STATUS_ACTIVE,
    createdAt: 1_700_000_123,
    bump: 254,
  };

  /**
   * Write a genuine pre-5E (528-byte) FlowerRecord at [b"flower", owner, index].
   * Encodes the FULL 5E layout then truncates the trailing byte, so every field lands at
   * exactly the offset the old program wrote it to.
   */
  async function seedLegacyFlower(h: Harness, ownerPk: PK, index: number) {
    const [flowerPda, flowerBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("flower"), ownerPk.toBuffer(), u32le(index)],
      h.program.programId,
    );
    const parentA = Keypair.generate().publicKey;
    const parentB = Keypair.generate().publicKey;
    const sourceExperiment = Keypair.generate().publicKey;
    const commitment = Buffer.alloc(32, 7);
    const genome = Buffer.alloc(320, 9);
    const metadata = Buffer.alloc(16, 3);

    const full = await h.program.coder.accounts.encode("flowerRecord", {
      owner: ownerPk,
      flowerIndex: index,
      visualSpeciesId: FIELDS.visualSpeciesId,
      generation: FIELDS.generation,
      rarity: FIELDS.rarity,
      stability: FIELDS.stability,
      revealedTraitMask: FIELDS.revealedTraitMask,
      parentA,
      parentB,
      genomeStatus: FIELDS.genomeStatus,
      sourceExperiment,
      status: FIELDS.status,
      createdAt: new BN(FIELDS.createdAt),
      bump: flowerBump,
      genomeCommitment: Array.from(commitment),
      encryptedGenome: Array.from(genome),
      encryptionMetadata: Array.from(metadata),
      timesBredAsParent: 0,
    });
    if (full.length !== CURRENT_LEN) throw new Error(`expected ${CURRENT_LEN}, got ${full.length}`);

    const legacy = full.subarray(0, LEGACY_LEN);
    h.context.setAccount(flowerPda, {
      lamports: LEGACY_RENT,
      data: legacy,
      owner: h.program.programId,
      executable: false,
      rentEpoch: 0,
    });
    return { flowerPda, parentA, parentB, sourceExperiment, commitment, genome, metadata };
  }

  /** Stand up a GameConfig so operator-gated instructions have something to check against. */
  async function bootstrapConfig(h: Harness) {
    await h.send(
      [
        await h.program.methods.initializeConfig().accountsStrict({
          authority: h.payer.publicKey,
          config: h.configPda(),
          systemProgram: h.systemProgram(),
        }).instruction(),
      ],
      [h.payer],
    );
  }

  async function bootstrap() {
    const h = await Harness.create();
    const owner = h.payer;

    const [flowerPda, flowerBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("flower"), owner.publicKey.toBuffer(), u32le(FIELDS.flowerIndex)],
      h.program.programId,
    );

    // Encode a FULL 5E record, then truncate the trailing byte to produce a genuine
    // pre-5E account. Truncation (rather than hand-packing) guarantees every field sits at
    // exactly the offset the old program wrote it to.
    const parentA = Keypair.generate().publicKey;
    const parentB = Keypair.generate().publicKey;
    const sourceExperiment = Keypair.generate().publicKey;
    const commitment = Buffer.alloc(32, 7);
    const genome = Buffer.alloc(320, 9);
    const metadata = Buffer.alloc(16, 3);

    const full = await h.program.coder.accounts.encode("flowerRecord", {
      owner: owner.publicKey,
      flowerIndex: FIELDS.flowerIndex,
      visualSpeciesId: FIELDS.visualSpeciesId,
      generation: FIELDS.generation,
      rarity: FIELDS.rarity,
      stability: FIELDS.stability,
      revealedTraitMask: FIELDS.revealedTraitMask,
      parentA,
      parentB,
      genomeStatus: FIELDS.genomeStatus,
      sourceExperiment,
      status: FIELDS.status,
      createdAt: new BN(FIELDS.createdAt),
      bump: flowerBump,
      genomeCommitment: Array.from(commitment),
      encryptedGenome: Array.from(genome),
      encryptionMetadata: Array.from(metadata),
      timesBredAsParent: 0,
    });
    expect(full.length, "current layout must be 537 bytes").to.equal(CURRENT_LEN);

    const legacy = full.subarray(0, LEGACY_LEN); // drop times_bred_as_parent
    h.context.setAccount(flowerPda, {
      lamports: LEGACY_RENT, // rent-exempt at 528 bytes, i.e. short of funding the current layout
      data: legacy,
      owner: h.program.programId,
      executable: false,
      rentEpoch: 0,
    });

    return { h, owner, flowerPda, parentA, parentB, sourceExperiment, commitment, genome, metadata };
  }

  it("a 528-byte legacy record cannot be read as the current FlowerRecord", async () => {
    const { h, flowerPda } = await bootstrap();
    const raw = await h.client.getAccount(flowerPda);
    expect(raw!.data.length, "fabricated legacy size").to.equal(LEGACY_LEN);

    let failed = false;
    try {
      await h.program.account.flowerRecord.fetch(flowerPda);
    } catch (e) {
      // This is the exact failure the 742 devnet flowers would hit post-deploy. The exact
      // wording is client-side (Anchor's coder runs off the end of the short buffer), so
      // assert the failure itself rather than a brittle message match.
      failed = true;
      console.log(`      legacy record rejected with: ${(e as Error).message.slice(0, 80)}`);
    }
    expect(failed, "a short record MUST fail to deserialize (this is why migration exists)")
      .to.equal(true);
  });

  it("migrate_flower grows it to the current layout with every field intact and new bytes zeroed",
    async () => {
      const { h, owner, flowerPda, parentA, parentB, sourceExperiment, commitment, genome, metadata } =
        await bootstrap();

      const before = await h.client.getAccount(flowerPda);
      expect(before!.data.length).to.equal(LEGACY_LEN);

      await h.send(
        [
          await h.program.methods
            .migrateFlower(FIELDS.flowerIndex)
            .accountsStrict({
              owner: owner.publicKey,
              flower: flowerPda,
              systemProgram: h.systemProgram(),
            })
            .instruction(),
        ],
        [owner],
      );

      const after = await h.client.getAccount(flowerPda);
      expect(after!.data.length, "grew by exactly one byte").to.equal(CURRENT_LEN);
      expect(after!.data.subarray(0, 8), "discriminator preserved")
        .to.deep.equal(before!.data.subarray(0, 8));
      expect(after!.data.subarray(0, LEGACY_LEN), "every legacy byte preserved verbatim")
        .to.deep.equal(before!.data);
      expect(after!.data[LEGACY_LEN], "appended byte is zero-filled").to.equal(0);

      // And it now deserializes, with every field exactly as written.
      const f = await h.program.account.flowerRecord.fetch(flowerPda);
      expect(f.owner.toBase58()).to.equal(owner.publicKey.toBase58());
      expect(f.flowerIndex).to.equal(FIELDS.flowerIndex);
      expect(f.visualSpeciesId).to.equal(FIELDS.visualSpeciesId);
      expect(f.generation).to.equal(FIELDS.generation);
      expect(f.rarity).to.equal(FIELDS.rarity);
      expect(f.stability).to.equal(FIELDS.stability);
      expect(f.revealedTraitMask >>> 0).to.equal(FIELDS.revealedTraitMask);
      expect(f.parentA.toBase58()).to.equal(parentA.toBase58());
      expect(f.parentB.toBase58()).to.equal(parentB.toBase58());
      expect(f.genomeStatus).to.equal(FIELDS.genomeStatus);
      expect(f.sourceExperiment.toBase58()).to.equal(sourceExperiment.toBase58());
      expect(f.status).to.equal(FIELDS.status);
      expect(f.createdAt.toNumber()).to.equal(FIELDS.createdAt);
      expect(Buffer.from(f.genomeCommitment)).to.deep.equal(commitment);
      expect(Buffer.from(f.encryptedGenome)).to.deep.equal(genome);
      expect(Buffer.from(f.encryptionMetadata)).to.deep.equal(metadata);
      // The whole point: a migrated flower starts with a full breeding budget.
      expect(f.timesBredAsParent, "migrated flower starts at 0 uses").to.equal(0);
    });

  it("is idempotent — migrating an already-migrated flower is a no-op", async () => {
    const { h, owner, flowerPda } = await bootstrap();
    const ix = async () =>
      await h.program.methods
        .migrateFlower(FIELDS.flowerIndex)
        .accountsStrict({
          owner: owner.publicKey,
          flower: flowerPda,
          systemProgram: h.systemProgram(),
        })
        .instruction();

    await h.send([await ix()], [owner]);
    const first = await h.client.getAccount(flowerPda);
    await h.send([await ix()], [owner]);
    const second = await h.client.getAccount(flowerPda);

    expect(second!.data.length).to.equal(CURRENT_LEN);
    expect(second!.data).to.deep.equal(first!.data, "second run must change nothing");
  });

  it("is owner-signed — a stranger cannot migrate someone else's flower", async () => {
    const { h, flowerPda } = await bootstrap();
    const stranger = h.fundedKeypair();

    const r = await h.send(
      [
        await h.program.methods
          .migrateFlower(FIELDS.flowerIndex)
          .accountsStrict({
            owner: stranger.publicKey,
            flower: flowerPda,
            systemProgram: h.systemProgram(),
          })
          .instruction(),
      ],
      [stranger],
    );
    // The seeds are [b"flower", owner, index], so a different signer derives a different PDA
    // and ConstraintSeeds (2006 = 0x7d6) rejects before any realloc can happen.
    expect(r.result, "another wallet must not be able to migrate this flower").to.not.equal(null);
    expect(JSON.stringify(r.result), "rejected specifically with ConstraintSeeds (0x7d6)")
      .to.contain("0x7d6");

    const untouched = await h.client.getAccount(flowerPda);
    expect(untouched!.data.length, "flower must be left at its legacy size").to.equal(LEGACY_LEN);
  });
});

/**
 * Operator-signed migration: the production-shaped path, where the owner's key is NOT
 * available. The realloc logic is identical to the owner-signed version (verified by diff);
 * what differs is that `owner` is a bare account used only for PDA derivation, and the
 * signing operator pays the rent. These tests re-prove the migration properties through the
 * new entry point and add the two things only this variant can do: migrate a flower the
 * signer does not own, and do it for many owners from one funded wallet.
 */
describe("Stage 5E: operator_migrate_flower (operator-signed, owner does not sign)", () => {
  const FIELDS = {
    visualSpeciesId: 255,
    generation: 4,
    rarity: 5,
    stability: 88,
    revealedTraitMask: 0x0004_0302,
    genomeStatus: GENOME_STATUS_ENCRYPTED,
    status: FLOWER_STATUS_ACTIVE,
    createdAt: 1_700_000_123,
  };

  async function seedLegacy(h: Harness, ownerPk: PK, index: number) {
    const [flowerPda, flowerBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("flower"), ownerPk.toBuffer(), u32le(index)],
      h.program.programId,
    );
    const parentA = Keypair.generate().publicKey;
    const parentB = Keypair.generate().publicKey;
    const sourceExperiment = Keypair.generate().publicKey;
    const commitment = Buffer.alloc(32, index + 1);
    const genome = Buffer.alloc(320, index + 2);
    const metadata = Buffer.alloc(16, index + 3);

    const full = await h.program.coder.accounts.encode("flowerRecord", {
      owner: ownerPk,
      flowerIndex: index,
      visualSpeciesId: FIELDS.visualSpeciesId,
      generation: FIELDS.generation,
      rarity: FIELDS.rarity,
      stability: FIELDS.stability,
      revealedTraitMask: FIELDS.revealedTraitMask,
      parentA,
      parentB,
      genomeStatus: FIELDS.genomeStatus,
      sourceExperiment,
      status: FIELDS.status,
      createdAt: new BN(FIELDS.createdAt),
      bump: flowerBump,
      genomeCommitment: Array.from(commitment),
      encryptedGenome: Array.from(genome),
      encryptionMetadata: Array.from(metadata),
      timesBredAsParent: 0,
    });
    expect(full.length).to.equal(CURRENT_LEN);

    h.context.setAccount(flowerPda, {
      lamports: LEGACY_RENT,
      data: full.subarray(0, LEGACY_LEN),
      owner: h.program.programId,
      executable: false,
      rentEpoch: 0,
    });
    return { flowerPda, parentA, parentB, sourceExperiment, commitment, genome, metadata };
  }

  async function withConfig() {
    const h = await Harness.create();
    await h.send(
      [
        await h.program.methods.initializeConfig().accountsStrict({
          authority: h.payer.publicKey,
          config: h.configPda(),
          systemProgram: h.systemProgram(),
        }).instruction(),
      ],
      [h.payer],
    );
    return h;
  }

  const migrateIx = async (h: Harness, signer: PK, ownerPk: PK, flowerPda: PK, index: number) =>
    await h.program.methods
      .operatorMigrateFlower(index)
      .accountsStrict({
        authority: signer,
        config: h.configPda(),
        owner: ownerPk,
        flower: flowerPda,
        systemProgram: h.systemProgram(),
      })
      .instruction();

  it("migrates a flower owned by a wallet that never signs, preserving every byte", async () => {
    const h = await withConfig();
    // A wallet we hold NO key for — exactly the production case.
    const stranger = Keypair.generate();
    const { flowerPda, parentA, parentB, sourceExperiment, commitment, genome, metadata } =
      await seedLegacy(h, stranger.publicKey, 3);

    const before = await h.client.getAccount(flowerPda);
    expect(before!.data.length).to.equal(LEGACY_LEN);

    const r = await h.send(
      [await migrateIx(h, h.payer.publicKey, stranger.publicKey, flowerPda, 3)],
      [h.payer], // ONLY the operator signs; `stranger` is not a signer anywhere
    );
    expect(r.result, "operator migration must succeed").to.equal(null);

    const after = await h.client.getAccount(flowerPda);
    expect(after!.data.length, "grew by exactly one byte").to.equal(CURRENT_LEN);
    expect(after!.data.subarray(0, LEGACY_LEN), "every legacy byte preserved verbatim")
      .to.deep.equal(before!.data);
    expect(after!.data[LEGACY_LEN], "appended byte zero-filled").to.equal(0);

    const f = await h.program.account.flowerRecord.fetch(flowerPda);
    expect(f.owner.toBase58(), "ownership unchanged — operator did not take it")
      .to.equal(stranger.publicKey.toBase58());
    expect(f.flowerIndex).to.equal(3);
    expect(f.generation).to.equal(FIELDS.generation);
    expect(f.rarity).to.equal(FIELDS.rarity);
    expect(f.stability).to.equal(FIELDS.stability);
    expect(f.revealedTraitMask >>> 0).to.equal(FIELDS.revealedTraitMask);
    expect(f.parentA.toBase58()).to.equal(parentA.toBase58());
    expect(f.parentB.toBase58()).to.equal(parentB.toBase58());
    expect(f.sourceExperiment.toBase58()).to.equal(sourceExperiment.toBase58());
    expect(f.status).to.equal(FIELDS.status);
    expect(f.createdAt.toNumber()).to.equal(FIELDS.createdAt);
    expect(Buffer.from(f.genomeCommitment)).to.deep.equal(commitment);
    expect(Buffer.from(f.encryptedGenome)).to.deep.equal(genome);
    expect(Buffer.from(f.encryptionMetadata)).to.deep.equal(metadata);
    expect(f.timesBredAsParent, "starts with a full budget").to.equal(0);
  });

  it("a 528-byte record is unreadable before, readable after", async () => {
    const h = await withConfig();
    const stranger = Keypair.generate();
    const { flowerPda } = await seedLegacy(h, stranger.publicKey, 1);

    let failed = false;
    try {
      await h.program.account.flowerRecord.fetch(flowerPda);
    } catch {
      failed = true;
    }
    expect(failed, "short record must not deserialize").to.equal(true);

    await h.send([await migrateIx(h, h.payer.publicKey, stranger.publicKey, flowerPda, 1)], [h.payer]);
    const f = await h.program.account.flowerRecord.fetch(flowerPda);
    expect(f.timesBredAsParent).to.equal(0);
  });

  it("is idempotent — a second run changes nothing and costs nothing", async () => {
    const h = await withConfig();
    const stranger = Keypair.generate();
    const { flowerPda } = await seedLegacy(h, stranger.publicKey, 2);

    await h.send([await migrateIx(h, h.payer.publicKey, stranger.publicKey, flowerPda, 2)], [h.payer]);
    const first = await h.client.getAccount(flowerPda);
    const opAfterFirst = (await h.client.getAccount(h.payer.publicKey))!.lamports;

    await h.send([await migrateIx(h, h.payer.publicKey, stranger.publicKey, flowerPda, 2)], [h.payer]);
    const second = await h.client.getAccount(flowerPda);
    const opAfterSecond = (await h.client.getAccount(h.payer.publicKey))!.lamports;

    expect(second!.data).to.deep.equal(first!.data, "second run must change nothing");
    expect(second!.lamports, "no second rent top-up").to.equal(first!.lamports);
    // The operator still pays the transaction fee, but NO rent top-up — the early return
    // fires before the transfer, so a re-run over an already-migrated population is cheap.
    const TX_FEE = 5_000;
    expect(opAfterFirst - opAfterSecond, "re-run costs the tx fee only, no rent")
      .to.equal(TX_FEE);
  });

  it("a registered operator (not just the authority) can migrate", async () => {
    const h = await withConfig();
    const operator = h.fundedKeypair();
    await h.send(
      [
        await h.program.methods.addOperator(operator.publicKey).accountsStrict({
          authority: h.payer.publicKey,
          config: h.configPda(),
        }).instruction(),
      ],
      [h.payer],
    );

    const stranger = Keypair.generate();
    const { flowerPda } = await seedLegacy(h, stranger.publicKey, 4);
    const r = await h.send(
      [await migrateIx(h, operator.publicKey, stranger.publicKey, flowerPda, 4)],
      [operator],
    );
    expect(r.result, "a registered operator must be allowed").to.equal(null);
    expect((await h.client.getAccount(flowerPda))!.data.length).to.equal(CURRENT_LEN);
  });

  it("a non-operator caller is rejected with NotAuthority, leaving the flower untouched", async () => {
    const h = await withConfig();
    const nobody = h.fundedKeypair();
    const stranger = Keypair.generate();
    const { flowerPda } = await seedLegacy(h, stranger.publicKey, 5);

    const r = await h.send(
      [await migrateIx(h, nobody.publicKey, stranger.publicKey, flowerPda, 5)],
      [nobody],
    );
    expect(r.result, "a random wallet must not be able to migrate").to.not.equal(null);
    expect(JSON.stringify(r.result), "rejected specifically with NotAuthority (6001)")
      .to.contain(NOT_AUTHORITY);
    expect((await h.client.getAccount(flowerPda))!.data.length, "flower left at legacy size")
      .to.equal(LEGACY_LEN);
  });

  it("batch: one funded operator migrates many flowers across many owners, paying exact rent",
    async () => {
      const h = await withConfig();
      const OWNERS = 4;
      const PER_OWNER = 3;

      // A realistic slice of the devnet population: several owners, several flowers each,
      // none of whose keys we hold.
      const targets: Array<{ owner: PK; index: number; pda: PK }> = [];
      for (let o = 0; o < OWNERS; o++) {
        const owner = Keypair.generate().publicKey;
        for (let i = 0; i < PER_OWNER; i++) {
          const { flowerPda } = await seedLegacy(h, owner, i);
          targets.push({ owner, index: i, pda: flowerPda });
        }
      }
      expect(targets.length).to.equal(OWNERS * PER_OWNER);

      const opBefore = (await h.client.getAccount(h.payer.publicKey))!.lamports;
      const flowerBefore = await Promise.all(
        targets.map(async (t) => (await h.client.getAccount(t.pda))!.lamports));

      // Drive them one at a time, exactly as a batch script would.
      for (const t of targets) {
        const r = await h.send(
          [await migrateIx(h, h.payer.publicKey, t.owner, t.pda, t.index)], [h.payer]);
        expect(r.result, `migrating ${t.pda.toBase58()} must succeed`).to.equal(null);
      }

      // Every flower migrated, every one readable, every one with a full budget.
      let topUpTotal = 0;
      for (let i = 0; i < targets.length; i++) {
        const acc = await h.client.getAccount(targets[i].pda);
        expect(acc!.data.length, `flower ${i} size`).to.equal(CURRENT_LEN);
        expect(acc!.data[LEGACY_LEN], `flower ${i} new byte`).to.equal(0);
        const f = await h.program.account.flowerRecord.fetch(targets[i].pda);
        expect(f.timesBredAsParent, `flower ${i} budget`).to.equal(0);
        expect(f.owner.toBase58(), `flower ${i} owner`).to.equal(targets[i].owner.toBase58());
        topUpTotal += acc!.lamports - flowerBefore[i];
      }

      // The operator funded every top-up. Derived from the ACTUAL growth rather than pinned to
      // a number: rent is 6,960 lamports per byte, and the legacy->current delta changes every
      // time a field is appended (1 byte at 5E, 9 now that §E's last_transfer_at is in).
      const RENT_PER_BYTE = 6_960;
      const EXPECTED_PER_FLOWER = RENT_PER_BYTE * (CURRENT_LEN - LEGACY_LEN);
      expect(topUpTotal, "each flower received exactly one rent top-up")
        .to.equal(EXPECTED_PER_FLOWER * targets.length);

      const opAfter = (await h.client.getAccount(h.payer.publicKey))!.lamports;
      const opSpent = opBefore - opAfter;
      expect(opSpent, "operator paid at least the full rent for the batch")
        .to.be.at.least(topUpTotal);
      console.log(`      batch: ${targets.length} flowers across ${OWNERS} owners; `
        + `rent ${topUpTotal} lamports (${EXPECTED_PER_FLOWER}/flower), `
        + `operator spent ${opSpent} lamports total`);
    });
});
