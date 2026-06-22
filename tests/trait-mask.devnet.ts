/**
 * Secret Garden — DEVNET Stage 3C revealed-trait-mask gate (cluster 456).
 *
 * Proves two things against the LIVE devnet deployment after the Stage 3C redeploy
 * (breed circuit now returns `(Enc<Mxe, Genome>, u32)` — encrypted genome + a public,
 * MPC-random packed "revealed trait mask"):
 *
 *   (A) MASK POPULATION — bred offspring now carry a well-formed `revealed_trait_mask`
 *       (was always 0 pre-3C). The u32 packs four visual classes, one per byte:
 *         byte0 = petal, byte1 = color, byte2 = leaf, byte3 = stem.
 *       Each class is `(rng + species_nudge + salt) % 5`, so each byte MUST be in 0..=4.
 *       That range invariant is the deterministic correctness check (always true if the
 *       circuit packed correctly); "non-zero" is asserted across multiple offspring so a
 *       legitimately all-zero RNG draw on one flower can't flake the suite.
 *
 *   (B) Enc<Mxe> GENOME REGRESSION — the genome output must be byte-for-byte the proven
 *       Stage 3A/3B path. Test 2 breeds a gen-1 hybrid (an Encrypted parent, read via
 *       ArgBuilder::account()) with a starter → gen-2 offspring with a non-zero Encrypted
 *       genome. Success proves adding the revealed mask did NOT disturb the encrypted
 *       genome read/write or the MAC verification on cluster 456.
 *
 * Devnet realities (identical to tests/breeding.devnet.ts): Helius RPC has no working
 * WebSocket, so every landing tx is sent + confirmed over HTTP polling; MPC latency on
 * the shared cluster is higher, so timeouts are large. The before-hook is IDEMPOTENT:
 * it reads existing state and never re-inits config or re-uploads the circuit.
 *
 * Run:
 *   set -a; source .env; set +a
 *   ANCHOR_PROVIDER_URL=$HELIUS_RPC_URL ANCHOR_WALLET=~/.config/solana/id.json \
 *     ARCIUM_CLUSTER_OFFSET=456 npx mocha --no-config --timeout 1800000 \
 *     tests/trait-mask.devnet.ts
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

const GENOME_STATUS_ENCRYPTED = 1;
const FLOWER_STATUS_ACTIVE = 0;
const HYBRID_VISUAL_SPECIES_ID = 255;
const EXPERIMENT_STATUS_QUEUED = 0;
const EXPERIMENT_STATUS_COMPLETED = 2;
const MAX_CLASS = 4; // classes are `% 5` -> 0..=4

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Unpack the Stage 3C packed-class mask into its four visual classes. */
function decodeMask(mask: number): {
  petal: number;
  color: number;
  leaf: number;
  stem: number;
} {
  return {
    petal: mask & 0xff,
    color: (mask >>> 8) & 0xff,
    leaf: (mask >>> 16) & 0xff,
    stem: (mask >>> 24) & 0xff,
  };
}

describe("secret-garden DEVNET: Stage 3C revealed-trait-mask gate (cluster 456)", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const conn = provider.connection;
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
  // Flower index of the gen-1 hybrid bred in test 1; consumed by test 2 as the encrypted
  // parent. Captured at runtime so the suite is re-runnable on a non-fresh devnet profile.
  let hybridIndex: number;
  // Masks collected from every bred offspring; used for the cross-offspring "population"
  // assertion that survives a single all-zero RNG draw.
  const observedMasks: number[] = [];

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

  // ---- HTTP-only send + confirm (no WebSocket; see header) -------------------------
  async function sendTxHttp(
    tx: anchor.web3.Transaction,
    label: string,
  ): Promise<{ sig: string }> {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const bh = await conn.getLatestBlockhash({ commitment: "confirmed" });
      tx.recentBlockhash = bh.blockhash;
      tx.lastValidBlockHeight = bh.lastValidBlockHeight;
      tx.feePayer = owner.publicKey;
      tx.signatures = [];
      tx.sign(owner);
      let sig: string;
      try {
        sig = await conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: true,
          maxRetries: 0,
          preflightCommitment: "confirmed",
        });
      } catch (e) {
        console.log(`    ${label} send err (attempt ${attempt}): ${(e as Error).message.slice(0, 90)}`);
        await sleep(Math.min(6000, 500 * 2 ** (attempt - 1)));
        continue;
      }
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const st = (await conn.getSignatureStatuses([sig])).value[0];
        if (st) {
          if (st.err) {
            throw new Error(`${label} tx FAILED on-chain: ${JSON.stringify(st.err)} (sig ${sig})`);
          }
          if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") {
            return { sig };
          }
        }
        const h = await conn.getBlockHeight({ commitment: "confirmed" });
        if (h > bh.lastValidBlockHeight) break;
        await sleep(800);
      }
      console.log(`    ${label} not confirmed (attempt ${attempt}); retrying`);
    }
    throw new Error(`${label} failed to confirm after retries`);
  }

  /** Queue one breeding of two owned flowers and return the derived PDAs + offset. */
  async function queueBreeding(
    flowerAIndex: number,
    flowerBIndex: number,
  ): Promise<{ experiment: PK; offspring: PK; offset: BN }> {
    const profile = await program.account.playerProfile.fetch(profilePda);
    const experiment = experimentPda(profile.totalExperiments);
    const offspring = flowerPda(profile.nextFlowerIndex);
    const offset = new BN(randomBytes(8), "hex");

    const nonce = randomBytes(16);
    const ct = cipher.encrypt([BigInt(40), BigInt(120), BigInt(200)], nonce);

    const tx = await program.methods
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
      .transaction();
    await sendTxHttp(tx, `startBreeding(${flowerAIndex},${flowerBIndex})`);

    return { experiment, offspring, offset };
  }

  async function waitForExperiment(
    pda: PK,
    status: number,
    maxMs = 300000,
  ): Promise<Awaited<ReturnType<typeof program.account.experiment.fetch>>> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const exp = await program.account.experiment.fetch(pda);
      if (exp.status === status) return exp;
      if (exp.status !== EXPERIMENT_STATUS_QUEUED) {
        throw new Error(`experiment resolved to unexpected status ${exp.status}`);
      }
      await sleep(1000);
    }
    throw new Error(`experiment did not reach status ${status} in time`);
  }

  /** Assert a bred offspring's mask is well-formed (4 packed classes, each 0..=4). */
  function assertWellFormedMask(mask: number, label: string): void {
    expect(Number.isInteger(mask), `${label} mask integer`).to.equal(true);
    expect(mask, `${label} mask non-negative`).to.be.at.least(0);
    const c = decodeMask(mask);
    for (const [name, v] of Object.entries(c)) {
      expect(v, `${label} ${name} class in 0..=${MAX_CLASS}`).to.be.within(0, MAX_CLASS);
    }
    // The four packed bytes fully account for the value -> no stray high bits.
    const repacked =
      c.petal + c.color * 256 + c.leaf * 65_536 + c.stem * 16_777_216;
    expect(repacked, `${label} mask == repacked classes (no stray bits)`).to.equal(mask);
    console.log(`    ${label} mask=${mask} classes=${JSON.stringify(c)}`);
  }

  before(async function () {
    this.timeout(600000);

    // GameConfig: read-only (already initialized + verified on devnet).
    const cfg = await program.account.gameConfig.fetch(configPda);
    if (!cfg.authority.equals(owner.publicKey)) {
      throw new Error(`GameConfig authority ${cfg.authority.toBase58()} != operator ${owner.publicKey.toBase58()}`);
    }
    if (cfg.paused) {
      throw new Error("GameConfig is paused; unpause before running the mask gate");
    }
    console.log(`[setup] GameConfig ok (authority ok, paused=${cfg.paused}, round=${cfg.currentRound})`);

    // PlayerProfile: create only if missing.
    if (await conn.getAccountInfo(profilePda)) {
      console.log(`[setup] PlayerProfile exists; skipping createProfile`);
    } else {
      const tx = await program.methods
        .createProfile()
        .accountsPartial({ owner: owner.publicKey, config: configPda, profile: profilePda })
        .transaction();
      await sendTxHttp(tx, "createProfile");
      console.log(`[setup] createProfile sent`);
    }

    // Starters: claim only if flower 0 missing.
    if (await conn.getAccountInfo(flowerPda(0))) {
      console.log(`[setup] starters exist; skipping claimStarters`);
    } else {
      const tx = await program.methods
        .claimStarters()
        .accountsPartial({
          owner: owner.publicKey,
          config: configPda,
          profile: profilePda,
          flower0: flowerPda(0), flower1: flowerPda(1), flower2: flowerPda(2),
          flower3: flowerPda(3), flower4: flowerPda(4), flower5: flowerPda(5),
        })
        .transaction();
      await sendTxHttp(tx, "claimStarters");
      console.log(`[setup] claimStarters sent`);
    }

    // breed comp-def: must already be finalized (re-uploaded post-redeploy this session).
    const arciumProgram = arcium.getArciumProgram(provider);
    const compDefPda = PublicKey.findProgramAddressSync(
      [arcium.getArciumAccountBaseSeed("ComputationDefinitionAccount"),
        program.programId.toBuffer(), arcium.getCompDefAccOffset("breed")],
      arcium.getArciumProgramId(),
    )[0];
    const cd: any = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPda);
    const completed = cd.circuitSource?.onChain?.[0]?.isCompleted;
    if (!completed) {
      throw new Error(`breed comp-def is NOT finalized (isCompleted=${completed}); run scripts/devnet-upload-circuit.ts first`);
    }
    console.log(`[setup] breed comp-def finalized (isCompleted=true)`);

    // MXE key exchange.
    let mxePublicKey: Uint8Array | null = null;
    for (let i = 0; i < 60; i++) {
      try {
        const key = await arcium.getMXEPublicKey(provider, program.programId);
        if (key) { mxePublicKey = key; break; }
      } catch { /* not ready */ }
      await sleep(1000);
    }
    if (!mxePublicKey) throw new Error("MXE public key unavailable after retries");

    const x25519Priv = arcium.x25519.utils.randomSecretKey();
    x25519Pub = arcium.x25519.getPublicKey(x25519Priv);
    cipher = new arcium.RescueCipher(
      arcium.x25519.getSharedSecret(x25519Priv, mxePublicKey),
    );
    console.log(`[setup] MXE pubkey acquired; key exchange done. Ready.`);
  });

  it("1) gen-1 breed populates a well-formed revealed_trait_mask (was 0 pre-3C)", async function () {
    this.timeout(600000);
    // Record the index this offspring will occupy so test 2 can breed it as the
    // encrypted parent regardless of how many flowers already exist on devnet.
    hybridIndex = (await program.account.playerProfile.fetch(profilePda)).nextFlowerIndex;
    const { experiment, offspring, offset } = await queueBreeding(0, 1);
    console.log(`  [1] queued; awaiting MPC finalization...`);
    await arcium.awaitComputationFinalization(provider, offset, program.programId, "confirmed", 360000);

    const exp = await waitForExperiment(experiment, EXPERIMENT_STATUS_COMPLETED);
    expect(exp.callbackProcessed).to.equal(true);

    const child = await program.account.flowerRecord.fetch(offspring);
    // Genome regression: the Enc<Mxe> path is unchanged from Stage 3A/3B.
    expect(child.genomeStatus).to.equal(GENOME_STATUS_ENCRYPTED);
    expect(child.visualSpeciesId).to.equal(HYBRID_VISUAL_SPECIES_ID);
    expect(child.generation).to.equal(1);
    expect(child.status).to.equal(FLOWER_STATUS_ACTIVE);
    expect(child.encryptedGenome.some((b: number) => b !== 0)).to.equal(true);

    // Stage 3C: the mask is now written by the MPC callback and must be well-formed.
    assertWellFormedMask(child.revealedTraitMask, "[1] gen-1");
    observedMasks.push(child.revealedTraitMask);
    console.log(`  [1] PASS — gen-1 offspring ${offspring.toBase58()} mask populated + genome encrypted`);
  });

  it("2) Enc<Mxe> regression — gen-2 hybrid (encrypted parent) keeps genome + mask", async function () {
    this.timeout(600000);
    // `hybridIndex` is the gen-1 hybrid bred in test 1 (an Encrypted genome). Breeding it
    // exercises ArgBuilder::account() reading the stored ciphertext — the proven path.
    const { experiment, offspring, offset } = await queueBreeding(hybridIndex, 2);
    console.log(`  [2] queued encrypted-parent breeding; awaiting MPC finalization...`);
    await arcium.awaitComputationFinalization(provider, offset, program.programId, "confirmed", 360000);

    const exp = await waitForExperiment(experiment, EXPERIMENT_STATUS_COMPLETED);
    expect(exp.callbackProcessed).to.equal(true);

    const child = await program.account.flowerRecord.fetch(offspring);
    // Priority Zero unchanged: encrypted-parent read + MAC verify still produce an
    // Encrypted, non-zero gen-2 genome after the mask was added.
    expect(child.genomeStatus).to.equal(GENOME_STATUS_ENCRYPTED);
    expect(child.generation).to.equal(2); // max(hybrid gen 1, starter gen 0) + 1
    expect(child.encryptedGenome.some((b: number) => b !== 0)).to.equal(true);

    assertWellFormedMask(child.revealedTraitMask, "[2] gen-2");
    observedMasks.push(child.revealedTraitMask);
    console.log(`  [2] PASS — gen-2 encrypted-parent offspring ${offspring.toBase58()} genome + mask intact`);
  });

  it("3) mask population — at least one bred offspring has a non-zero mask", function () {
    // Each class is RNG % 5, so a single offspring is all-zero with prob (1/5)^4 = 1/625.
    // Across the offspring bred above the all-zero probability is negligible, so a non-zero
    // mask somewhere proves the mask is genuinely MPC-populated (not the pre-3C constant 0).
    expect(observedMasks.length, "offspring bred").to.be.at.least(2);
    expect(
      observedMasks.some((m) => m !== 0),
      `expected a non-zero mask among ${JSON.stringify(observedMasks)}`,
    ).to.equal(true);
    console.log(`  [3] PASS — masks observed: ${JSON.stringify(observedMasks)}`);
  });
});
