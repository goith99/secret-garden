/**
 * Secret Garden — DEVNET breeding computation gate (cluster 456).
 *
 * Devnet-specific variant of tests/breeding.ts. The localnet original is preserved and
 * still drives `arcium test`; this file runs the SAME breeding computation tests against
 * the LIVE devnet deployment, where setup is already done and verified on-chain:
 *   - GameConfig initialized (authority == operator),
 *   - PlayerProfile + 6 starters claimed,
 *   - breed comp-def registered AND its 438 KB circuit uploaded + finalized
 *     (isCompleted=true) — see scripts/devnet-upload-circuit.ts.
 * So the before-hook here is IDEMPOTENT: it reads existing state and only creates what's
 * genuinely missing; it never re-inits config or re-uploads the circuit.
 *
 * Two devnet realities differ from localnet and are handled explicitly:
 *   1. The Helius RPC endpoint has no working WebSocket (`signatureSubscribe` /
 *      `accountSubscribe` are rejected). So every tx that must LAND is sent + confirmed
 *      over HTTP polling (sendRawTransaction + getSignatureStatuses), NOT via
 *      Anchor's `.rpc()` (which relies on WS confirmation and times out under load).
 *      `awaitComputationFinalization` already polls over HTTP, so it is used as-is.
 *   2. MPC latency on the shared cluster is higher than localnet — timeouts are larger.
 *
 * Run:
 *   set -a; source .env; set +a
 *   ANCHOR_PROVIDER_URL=$HELIUS_RPC_URL ANCHOR_WALLET=~/.config/solana/id.json \
 *     ARCIUM_CLUSTER_OFFSET=456 npx mocha --no-config --timeout 1800000 \
 *     tests/breeding.devnet.ts
 *
 * Test (2) is the Priority Zero gate: a successful encrypted-parent breeding proves the
 * MPC MAC-verified the genome read via ArgBuilder::account() at the right offset on 456.
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
const STARTER_COUNT = 6;

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

describe("secret-garden DEVNET: encrypted breeding gate (cluster 456)", () => {
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
  // Flower index of the gen-1 hybrid that test 1 breeds; consumed by test 2 as the
  // encrypted parent. Captured at runtime (NOT hardcoded to STARTER_COUNT) so the suite
  // is re-runnable on a non-fresh devnet profile where prior offspring shifted the index.
  let hybridIndex: number;

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

  // ---- HTTP-only send + confirm (no WebSocket; see header note 1) -----------------
  async function sendTxHttp(
    tx: anchor.web3.Transaction,
    label: string,
    opts: { allowErr?: boolean } = {},
  ): Promise<{ sig: string; err: unknown | null }> {
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
      // poll confirmation over HTTP
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const st = (await conn.getSignatureStatuses([sig])).value[0];
        if (st) {
          if (st.err) {
            if (opts.allowErr) return { sig, err: st.err };
            throw new Error(`${label} tx FAILED on-chain: ${JSON.stringify(st.err)} (sig ${sig})`);
          }
          if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") {
            return { sig, err: null };
          }
        }
        const h = await conn.getBlockHeight({ commitment: "confirmed" });
        if (h > bh.lastValidBlockHeight) break; // expired -> retry with fresh blockhash
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

  before(async function () {
    this.timeout(600000);

    // --- GameConfig: read-only (already initialized + verified on devnet) ---
    const cfg = await program.account.gameConfig.fetch(configPda);
    if (!cfg.authority.equals(owner.publicKey)) {
      throw new Error(`GameConfig authority ${cfg.authority.toBase58()} != operator ${owner.publicKey.toBase58()}`);
    }
    console.log(`[setup] GameConfig exists (authority ok, paused=${cfg.paused}, round=${cfg.currentRound}); skipping init`);

    // --- PlayerProfile: create only if missing ---
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

    // --- Starters: claim only if flower 0 missing ---
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

    // --- breed comp-def: must already be finalized (uploaded this session) ---
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
    console.log(`[setup] breed comp-def finalized (isCompleted=true); skipping register+upload`);

    // --- MXE key exchange (always) ---
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

  /** Toggle the global pause kill-switch (authority-only). HTTP send. */
  async function setPaused(value: boolean): Promise<void> {
    const tx = await program.methods
      .setPaused(value)
      .accountsPartial({ authority: owner.publicKey, config: configPda })
      .transaction();
    await sendTxHttp(tx, `setPaused(${value})`);
  }

  it("0) start_breeding is rejected while the game is paused", async function () {
    this.timeout(180000);
    expect((await program.account.flowerRecord.fetch(flowerPda(0))).status,
      "flower 0 Active before paused attempt").to.equal(FLOWER_STATUS_ACTIVE);
    expect((await program.account.flowerRecord.fetch(flowerPda(1))).status,
      "flower 1 Active before paused attempt").to.equal(FLOWER_STATUS_ACTIVE);

    await setPaused(true);
    try {
      const profile = await program.account.playerProfile.fetch(profilePda);
      const experiment = experimentPda(profile.totalExperiments);
      const offspring = flowerPda(profile.nextFlowerIndex);
      const offset = new BN(randomBytes(8), "hex");
      const nonce = randomBytes(16);
      const ct = cipher.encrypt([BigInt(40), BigInt(120), BigInt(200)], nonce);

      // Build + send WITH preflight so the simulation surfaces the parsed "GamePaused"
      // error (HTTP simulateTransaction; no WS confirmation needed for a rejection).
      let failed = false;
      try {
        await program.methods
          .startBreeding(
            offset, Array.from(x25519Pub),
            new BN(arcium.deserializeLE(nonce).toString()),
            Array.from(ct[0]), Array.from(ct[1]), Array.from(ct[2]),
          )
          .accountsPartial({
            player: owner.publicKey, profile: profilePda,
            flowerA: flowerPda(0), flowerB: flowerPda(1),
            experiment, offspring, ...arciumAccountsFor(offset),
          })
          .signers([owner])
          .rpc({ commitment: "confirmed" }); // preflight ON -> GamePaused from simulation
      } catch (e) {
        failed = true;
        expect(String(e)).to.contain("GamePaused");
      }
      expect(failed, "start_breeding must reject while paused").to.equal(true);
    } finally {
      await setPaused(false);
    }

    expect((await program.account.flowerRecord.fetch(flowerPda(0))).status,
      "flower 0 still Active after rejected paused attempt").to.equal(FLOWER_STATUS_ACTIVE);
    expect((await program.account.flowerRecord.fetch(flowerPda(1))).status,
      "flower 1 still Active after rejected paused attempt").to.equal(FLOWER_STATUS_ACTIVE);
  });

  it("1) happy path — both Starters → offspring with an Encrypted genome", async function () {
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
    expect(child.genomeStatus).to.equal(GENOME_STATUS_ENCRYPTED);
    expect(child.visualSpeciesId).to.equal(HYBRID_VISUAL_SPECIES_ID);
    expect(child.generation).to.equal(1);
    expect(child.status).to.equal(FLOWER_STATUS_ACTIVE);
    expect(child.parentA.equals(flowerPda(0))).to.equal(true);
    expect(child.parentB.equals(flowerPda(1))).to.equal(true);
    expect(child.sourceExperiment.equals(experiment)).to.equal(true);
    expect(child.encryptedGenome.some((b: number) => b !== 0)).to.equal(true);
    expect((await program.account.flowerRecord.fetch(flowerPda(0))).status).to.equal(FLOWER_STATUS_ACTIVE);
    expect((await program.account.flowerRecord.fetch(flowerPda(1))).status).to.equal(FLOWER_STATUS_ACTIVE);
    expect((await program.account.playerProfile.fetch(profilePda)).activeExperimentCount).to.equal(0);
    console.log(`  [1] PASS — offspring ${offspring.toBase58()} gen=1 encrypted`);
  });

  it("2) Priority Zero — Encrypted parent (reads stored ciphertext via account())", async function () {
    this.timeout(600000);
    // `hybridIndex` is the gen-1 hybrid that test 1 just bred (an Encrypted genome).
    const { experiment, offspring, offset } = await queueBreeding(hybridIndex, 2);
    console.log(`  [2] queued encrypted-parent breeding; awaiting MPC finalization...`);
    await arcium.awaitComputationFinalization(provider, offset, program.programId, "confirmed", 360000);

    // Success here means the MPC MAC-verified the genome read from the hybrid's account
    // at FLOWER_ENCRYPTED_GENOME_OFFSET via ArgBuilder::account() — Priority Zero proven.
    const exp = await waitForExperiment(experiment, EXPERIMENT_STATUS_COMPLETED);
    expect(exp.callbackProcessed).to.equal(true);

    const child = await program.account.flowerRecord.fetch(offspring);
    expect(child.genomeStatus).to.equal(GENOME_STATUS_ENCRYPTED);
    expect(child.generation).to.equal(2); // max(hybrid gen 1, starter gen 0) + 1
    expect(child.encryptedGenome.some((b: number) => b !== 0)).to.equal(true);
    console.log(`  [2] PASS — encrypted-parent offspring ${offspring.toBase58()} gen=2 encrypted; ArgBuilder::account() verified on cluster 456`);
  });

  it("3) parallel — two experiments in flight without PDA collision or count corruption", async function () {
    this.timeout(900000);
    const before = await program.account.playerProfile.fetch(profilePda);

    // Queue two breedings. `b` is queued after `a`'s START tx confirms (the queue, NOT the
    // MPC callback) so it derives PDAs from the post-`a` counters — both experiments are
    // then in flight before either RESOLVES.
    const a = await queueBreeding(0, 1);
    const b = await queueBreeding(2, 3);

    // No collision: the two in-flight experiments/offspring get distinct PDAs.
    expect(a.experiment.equals(b.experiment)).to.equal(false);
    expect(a.offspring.equals(b.offspring)).to.equal(false);

    // The actual Stage-3A guarantee is the `total_experiments`-based nonce, which is
    // MONOTONIC — each start_breeding advances total_experiments + nextFlowerIndex by one
    // and a callback never decrements them. Asserting they advanced by exactly 2 proves
    // correct concurrent queueing INDEPENDENTLY of how fast the callbacks land (on devnet
    // a callback can finalize in ~6s, so the transient activeExperimentCount is racy and
    // is NOT asserted at an exact value here).
    const afterQueue = await program.account.playerProfile.fetch(profilePda);
    expect(afterQueue.totalExperiments).to.equal(before.totalExperiments + 2);
    expect(afterQueue.nextFlowerIndex).to.equal(before.nextFlowerIndex + 2);
    expect(afterQueue.activeExperimentCount).to.be.within(
      before.activeExperimentCount,
      before.activeExperimentCount + 2,
    );

    // Both resolve independently to completed, encrypted, gen-1 offspring.
    await arcium.awaitComputationFinalization(provider, a.offset, program.programId, "confirmed", 360000);
    await arcium.awaitComputationFinalization(provider, b.offset, program.programId, "confirmed", 360000);
    const expA = await waitForExperiment(a.experiment, EXPERIMENT_STATUS_COMPLETED);
    const expB = await waitForExperiment(b.experiment, EXPERIMENT_STATUS_COMPLETED);
    expect(expA.callbackProcessed).to.equal(true);
    expect(expB.callbackProcessed).to.equal(true);
    for (const off of [a.offspring, b.offspring]) {
      const child = await program.account.flowerRecord.fetch(off);
      expect(child.genomeStatus).to.equal(GENOME_STATUS_ENCRYPTED);
      expect(child.generation).to.equal(1);
      expect(child.status).to.equal(FLOWER_STATUS_ACTIVE);
    }

    // Once both callbacks land, the active counter settles back to the pre-test baseline.
    expect((await program.account.playerProfile.fetch(profilePda)).activeExperimentCount)
      .to.equal(before.activeExperimentCount);
    console.log(`  [3] PASS — 2 experiments queued concurrently (total_experiments +2, distinct PDAs), both resolved, count back to baseline`);
  });
});
