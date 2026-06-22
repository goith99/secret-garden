/**
 * Secret Garden Protocol — Stage 3B live-cluster breeding tests.
 *
 * These run against a REAL Arcium localnet (`arcium test`), not bankrun: the whole
 * point is the MPC round-trip that bankrun cannot simulate. The encrypted-parent test
 * (test 2) is the Priority Zero verification — because the MPC MAC-verifies every
 * `Enc<Mxe>` input, a successful encrypted-parent breeding cryptographically confirms
 * that `ArgBuilder::account(flower, FLOWER_ENCRYPTED_GENOME_OFFSET, 320)` delivered the
 * correct stored ciphertext (a wrong offset would fail the MAC and abort).
 *
 * Imports use namespace form (`import * as`) because the Arcium/Anchor packages are
 * CommonJS and Node's native TS-stripping loader does not expose all of their re-exports
 * (e.g. `BN`) as named ESM imports.
 */
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import * as arcium from "@arcium-hq/client";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import { expect } from "chai";
import type { SecretGarden } from "../target/types/secret_garden";

const { PublicKey, Keypair } = anchor.web3;
type PK = anchor.web3.PublicKey;

// Mirror of on-chain constants (programs/.../constants.rs).
const GENOME_STATUS_ENCRYPTED = 1;
const FLOWER_STATUS_ACTIVE = 0;
const HYBRID_VISUAL_SPECIES_ID = 255;
const EXPERIMENT_STATUS_QUEUED = 0;
const EXPERIMENT_STATUS_COMPLETED = 2;
const STARTER_COUNT = 6;

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function readKpJson(path: string): anchor.web3.Keypair {
  return Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(path).toString())),
  );
}

describe("secret-garden Stage 3B: encrypted breeding (live cluster)", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.SecretGarden as anchor.Program<SecretGarden>;
  const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);

  const arciumEnv = arcium.getArciumEnv();
  const clusterAccount = arcium.getClusterAccAddress(
    arciumEnv.arciumClusterOffset,
  );

  const configPda = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId,
  )[0];
  const profilePda = PublicKey.findProgramAddressSync(
    [Buffer.from("profile"), owner.publicKey.toBuffer()],
    program.programId,
  )[0];
  const flowerPda = (index: number): PK =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("flower"), owner.publicKey.toBuffer(), u32le(index)],
      program.programId,
    )[0];
  const experimentPda = (index: number): PK =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("experiment"), owner.publicKey.toBuffer(), u32le(index)],
      program.programId,
    )[0];

  let cipher: arcium.RescueCipher;
  let x25519Pub: Uint8Array;

  const arciumAccountsFor = (computationOffset: BN) => ({
    computationAccount: arcium.getComputationAccAddress(
      arciumEnv.arciumClusterOffset,
      computationOffset,
    ),
    clusterAccount,
    mxeAccount: arcium.getMXEAccAddress(program.programId),
    mempoolAccount: arcium.getMempoolAccAddress(arciumEnv.arciumClusterOffset),
    executingPool: arcium.getExecutingPoolAccAddress(
      arciumEnv.arciumClusterOffset,
    ),
    compDefAccount: arcium.getCompDefAccAddress(
      program.programId,
      Buffer.from(arcium.getCompDefAccOffset("breed")).readUInt32LE(),
    ),
  });

  /** Queue one breeding of two owned flowers and return the derived PDAs + offset. */
  async function queueBreeding(
    flowerAIndex: number,
    flowerBIndex: number,
  ): Promise<{ experiment: PK; offspring: PK; offset: BN }> {
    const profile = await program.account.playerProfile.fetch(profilePda);
    const experiment = experimentPda(profile.totalExperiments);
    const offspring = flowerPda(profile.nextFlowerIndex);
    const offset = new BN(randomBytes(8), "hex");

    // Encrypt the private environment (light, water, soil) under one nonce.
    const nonce = randomBytes(16);
    const ct = cipher.encrypt([BigInt(40), BigInt(120), BigInt(200)], nonce);

    await program.methods
      .startBreeding(
        offset,
        Array.from(x25519Pub),
        new BN(arcium.deserializeLE(nonce).toString()),
        Array.from(ct[0]),
        Array.from(ct[1]),
        Array.from(ct[2]),
      )
      .accountsPartial({
        player: owner.publicKey,
        profile: profilePda,
        flowerA: flowerPda(flowerAIndex),
        flowerB: flowerPda(flowerBIndex),
        experiment,
        offspring,
        ...arciumAccountsFor(offset),
      })
      .signers([owner])
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    return { experiment, offspring, offset };
  }

  /** Poll the experiment account until it reaches `status` (callback may lag the queue). */
  async function waitForExperiment(
    pda: PK,
    status: number,
    maxMs = 120000,
  ): Promise<Awaited<ReturnType<typeof program.account.experiment.fetch>>> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const exp = await program.account.experiment.fetch(pda);
      if (exp.status === status) return exp;
      if (exp.status !== EXPERIMENT_STATUS_QUEUED) {
        throw new Error(
          `experiment resolved to unexpected status ${exp.status}`,
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`experiment did not reach status ${status} in time`);
  }

  before(async function () {
    this.timeout(600000);

    await program.methods
      .initializeConfig()
      .accountsPartial({ authority: owner.publicKey, config: configPda })
      .signers([owner])
      .rpc({ commitment: "confirmed" });
    await program.methods
      .createProfile()
      .accountsPartial({
        owner: owner.publicKey,
        config: configPda,
        profile: profilePda,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });
    await program.methods
      .claimStarters()
      .accountsPartial({
        owner: owner.publicKey,
        config: configPda,
        profile: profilePda,
        flower0: flowerPda(0),
        flower1: flowerPda(1),
        flower2: flowerPda(2),
        flower3: flowerPda(3),
        flower4: flowerPda(4),
        flower5: flowerPda(5),
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });

    // Register the breed computation definition and upload the compiled circuit.
    const arciumProgram = arcium.getArciumProgram(provider);
    const compDefOffset = arcium.getCompDefAccOffset("breed");
    const compDefPda = PublicKey.findProgramAddressSync(
      [
        arcium.getArciumAccountBaseSeed("ComputationDefinitionAccount"),
        program.programId.toBuffer(),
        compDefOffset,
      ],
      arcium.getArciumProgramId(),
    )[0];
    const mxeAccount = arcium.getMXEAccAddress(program.programId);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    await program.methods
      .initBreedingCompDef()
      .accountsPartial({
        authority: owner.publicKey,
        config: configPda,
        compDefAccount: compDefPda,
        mxeAccount,
        addressLookupTable: arcium.getLookupTableAddress(
          program.programId,
          mxeAcc.lutOffsetSlot,
        ),
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });
    await arcium.uploadCircuit(
      provider,
      "breed",
      program.programId,
      fs.readFileSync("build/breed.arcis"),
      true,
      500,
      {
        skipPreflight: true,
        preflightCommitment: "confirmed",
        commitment: "confirmed",
      },
    );

    // Player environment key exchange. MXE keygen finalizes slowly on this host, so
    // poll generously (~4 min) before giving up.
    let mxePublicKey: Uint8Array | null = null;
    for (let i = 0; i < 240; i++) {
      try {
        const key = await arcium.getMXEPublicKey(provider, program.programId);
        if (key) {
          mxePublicKey = key;
          break;
        }
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!mxePublicKey)
      throw new Error("MXE public key unavailable after retries");

    const x25519Priv = arcium.x25519.utils.randomSecretKey();
    x25519Pub = arcium.x25519.getPublicKey(x25519Priv);
    cipher = new arcium.RescueCipher(
      arcium.x25519.getSharedSecret(x25519Priv, mxePublicKey),
    );
  });

  /** Toggle the global pause kill-switch (Stage 5A, authority-only). */
  async function setPaused(value: boolean): Promise<void> {
    await program.methods
      .setPaused(value)
      .accountsPartial({ authority: owner.publicKey, config: configPda })
      .signers([owner])
      .rpc({ commitment: "confirmed" });
  }

  it("0) start_breeding is rejected while the game is paused (Stage 5A)", async function () {
    this.timeout(120000);

    // Both parents start Active (claimed in `before`); a rejected paused attempt must
    // leave them exactly so (i.e. it must not have locked them).
    expect(
      (await program.account.flowerRecord.fetch(flowerPda(0))).status,
      "flower 0 Active before the paused attempt",
    ).to.equal(FLOWER_STATUS_ACTIVE);
    expect(
      (await program.account.flowerRecord.fetch(flowerPda(1))).status,
      "flower 1 Active before the paused attempt",
    ).to.equal(FLOWER_STATUS_ACTIVE);

    await setPaused(true);
    try {
      // Build start_breeding inline (mirroring `queueBreeding`) so it can be sent WITHOUT
      // `skipPreflight`. `queueBreeding` hardcodes `skipPreflight: true` (needed by the
      // live MPC tests 1-3) and is shared, so it must not be changed here. With preflight
      // ON, the simulation surfaces the PARSED on-chain error ("GamePaused") instead of the
      // opaque `Unknown action 'undefined'` a skip-preflight rejection produces — the same
      // approach tests/scoring.ts uses for its "pause halts ..." assertions.
      const profile = await program.account.playerProfile.fetch(profilePda);
      const experiment = experimentPda(profile.totalExperiments);
      const offspring = flowerPda(profile.nextFlowerIndex);
      const offset = new BN(randomBytes(8), "hex");
      const nonce = randomBytes(16);
      const ct = cipher.encrypt([BigInt(40), BigInt(120), BigInt(200)], nonce);

      let failed = false;
      try {
        await program.methods
          .startBreeding(
            offset,
            Array.from(x25519Pub),
            new BN(arcium.deserializeLE(nonce).toString()),
            Array.from(ct[0]),
            Array.from(ct[1]),
            Array.from(ct[2]),
          )
          .accountsPartial({
            player: owner.publicKey,
            profile: profilePda,
            flowerA: flowerPda(0),
            flowerB: flowerPda(1),
            experiment,
            offspring,
            ...arciumAccountsFor(offset),
          })
          .signers([owner])
          .rpc({ commitment: "confirmed" }); // NO skipPreflight — see comment above.
      } catch (e) {
        failed = true;
        // Positively confirm the SPECIFIC rejection is GamePaused, not just "it threw".
        expect(String(e)).to.contain("GamePaused");
      }
      expect(failed, "start_breeding must reject while paused").to.equal(true);
    } finally {
      // Always lift the pause so the rest of the suite runs normally.
      await setPaused(false);
    }

    // Explicitly confirm the rejected paused attempt did NOT lock the parents (Stage 5C
    // relied on this only implicitly, via the next test happening to succeed).
    expect(
      (await program.account.flowerRecord.fetch(flowerPda(0))).status,
      "flower 0 still Active after the rejected paused attempt",
    ).to.equal(FLOWER_STATUS_ACTIVE);
    expect(
      (await program.account.flowerRecord.fetch(flowerPda(1))).status,
      "flower 1 still Active after the rejected paused attempt",
    ).to.equal(FLOWER_STATUS_ACTIVE);
  });

  it("1) happy path — both Starters → offspring with an Encrypted genome", async function () {
    this.timeout(180000);
    const { experiment, offspring, offset } = await queueBreeding(0, 1);
    await arcium.awaitComputationFinalization(
      provider,
      offset,
      program.programId,
      "confirmed",
    );

    const exp = await waitForExperiment(
      experiment,
      EXPERIMENT_STATUS_COMPLETED,
    );
    expect(exp.callbackProcessed).to.equal(true);

    const child = await program.account.flowerRecord.fetch(offspring);
    expect(child.genomeStatus).to.equal(GENOME_STATUS_ENCRYPTED);
    expect(child.visualSpeciesId).to.equal(HYBRID_VISUAL_SPECIES_ID);
    expect(child.generation).to.equal(1);
    expect(child.status).to.equal(FLOWER_STATUS_ACTIVE);
    expect(child.parentA.equals(flowerPda(0))).to.equal(true);
    expect(child.parentB.equals(flowerPda(1))).to.equal(true);
    expect(child.sourceExperiment.equals(experiment)).to.equal(true);
    expect(child.encryptedGenome.some((b: number) => b !== 0)).to.equal(true);

    expect(
      (await program.account.flowerRecord.fetch(flowerPda(0))).status,
    ).to.equal(FLOWER_STATUS_ACTIVE);
    expect(
      (await program.account.flowerRecord.fetch(flowerPda(1))).status,
    ).to.equal(FLOWER_STATUS_ACTIVE);
    expect(
      (await program.account.playerProfile.fetch(profilePda))
        .activeExperimentCount,
    ).to.equal(0);
  });

  it("2) Priority Zero — Encrypted parent (reads stored ciphertext via account())", async function () {
    this.timeout(180000);
    // The offspring from test 1 lives at index STARTER_COUNT (6) and is Encrypted.
    const hybridIndex = STARTER_COUNT;
    const { experiment, offspring, offset } = await queueBreeding(
      hybridIndex,
      2,
    );
    await arcium.awaitComputationFinalization(
      provider,
      offset,
      program.programId,
      "confirmed",
    );

    // If the MPC finishes successfully, its MAC verified the genome read from the
    // hybrid's account at FLOWER_ENCRYPTED_GENOME_OFFSET — Priority Zero confirmed.
    const exp = await waitForExperiment(
      experiment,
      EXPERIMENT_STATUS_COMPLETED,
    );
    expect(exp.callbackProcessed).to.equal(true);

    const child = await program.account.flowerRecord.fetch(offspring);
    expect(child.genomeStatus).to.equal(GENOME_STATUS_ENCRYPTED);
    expect(child.generation).to.equal(2); // max(hybrid gen 1, starter gen 0) + 1
    expect(child.encryptedGenome.some((b: number) => b !== 0)).to.equal(true);
  });

  it("3) parallel — two experiments before either resolves (no PDA collision)", async function () {
    this.timeout(240000);
    const before = await program.account.playerProfile.fetch(profilePda);

    const a = await queueBreeding(0, 1);
    const b = await queueBreeding(2, 3);
    expect(a.experiment.equals(b.experiment)).to.equal(false);
    expect(a.offspring.equals(b.offspring)).to.equal(false);

    const mid = await program.account.playerProfile.fetch(profilePda);
    expect(mid.activeExperimentCount).to.equal(
      before.activeExperimentCount + 2,
    );

    await arcium.awaitComputationFinalization(
      provider,
      a.offset,
      program.programId,
      "confirmed",
    );
    await arcium.awaitComputationFinalization(
      provider,
      b.offset,
      program.programId,
      "confirmed",
    );
    await waitForExperiment(a.experiment, EXPERIMENT_STATUS_COMPLETED);
    await waitForExperiment(b.experiment, EXPERIMENT_STATUS_COMPLETED);

    expect(
      (await program.account.playerProfile.fetch(profilePda))
        .activeExperimentCount,
    ).to.equal(before.activeExperimentCount);
  });
});
