/**
 * Secret Garden — DEVNET Private Hint end-to-end gate (cluster 456).
 *
 * The DEFINITIVE live proof of the private_hint feature, in the same spirit as
 * tests/trait-mask.devnet.ts was for Stage 3C. It runs the FULL sealed round-trip against
 * the live devnet deployment (program upgraded with private_hint; circuit uploaded +
 * finalized, isCompleted=true, verified byte-for-byte):
 *
 *   queue_private_hint  ->  MPC seals a 1-byte trait bitmask to the player's fresh x25519
 *   key (Enc<Shared, u8>)  ->  private_hint_callback persists ciphertext+nonce+key into the
 *   per-player HintResult PDA  ->  the CLIENT decrypts it with its own private key.
 *
 * Only the requesting player can decrypt: the result is sealed to a fresh client x25519
 * key, never .reveal()'d and never Enc<Mxe>. Neither the operator nor the cluster learns it.
 *
 * Devnet realities (identical to tests/breeding.devnet.ts / trait-mask.devnet.ts): Helius
 * RPC has no working WebSocket, so every landing tx is sent + confirmed over HTTP polling;
 * MPC latency on the shared cluster is higher, so timeouts are large. The before-hook is
 * IDEMPOTENT: it reads existing state and only creates what is genuinely missing.
 *
 * FLOWER CHOICE: a hint is only meaningful on a flower with a REAL encrypted genome. Starter
 * flowers carry an all-zero genome (see claim_starters.rs) and private_hint has no starter
 * branch (it always `genome.to_arcis()`), so this test uses an ENCRYPTED hybrid — reusing an
 * existing one if the operator has any, otherwise breeding one (the proven breed flow).
 *
 * Run:
 *   set -a; source .env; set +a
 *   ANCHOR_PROVIDER_URL=$HELIUS_RPC_URL ANCHOR_WALLET=~/.config/solana/id.json \
 *     ARCIUM_CLUSTER_OFFSET=456 npx mocha --no-config --timeout 300000 \
 *     tests/private-hint.devnet.ts
 */
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import * as arcium from "@arcium-hq/client";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import { expect } from "chai";
import type { SecretGarden } from "../target/types/secret_garden";

const { PublicKey, Keypair, SystemProgram } = anchor.web3;
type PK = anchor.web3.PublicKey;

const GENOME_STATUS_ENCRYPTED = 1;
const FLOWER_STATUS_ACTIVE = 0;
const ROUND_STATUS_OPEN = 0;
const ROUND_STATUS_CLOSED = 1;
const ROUND_STATUS_FINALIZED = 2;
const EXPERIMENT_STATUS_QUEUED = 0;
const EXPERIMENT_STATUS_COMPLETED = 2;
const STARTER_COUNT = 6;

// Mirror of constants::TRAIT_TABLE (id -> human name) for readable reporting.
const TRAIT_TABLE = [
  "Crimson", "Pale", "Full Bloom", "Broadleaf", "Tall",
  "Fragrant", "Hardy", "Recessive Carrier", "Mutant", "Stable",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const popcount = (x: number): number => { let c = 0; while (x) { c += x & 1; x >>>= 1; } return c; };

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function u64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
function readKpJson(path: string): anchor.web3.Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path).toString())));
}

describe("secret-garden DEVNET: private_hint end-to-end (cluster 456)", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const conn = provider.connection;
  const program = anchor.workspace.SecretGarden as anchor.Program<SecretGarden>;
  const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);

  const arciumEnv = arcium.getArciumEnv();
  const clusterAccount = arcium.getClusterAccAddress(arciumEnv.arciumClusterOffset);

  const configPda = PublicKey.findProgramAddressSync(
    [Buffer.from("config")], program.programId)[0];
  const profilePda = (o: PK = owner.publicKey): PK => PublicKey.findProgramAddressSync(
    [Buffer.from("profile"), o.toBuffer()], program.programId)[0];
  const flowerPda = (index: number, o: PK = owner.publicKey): PK => PublicKey.findProgramAddressSync(
    [Buffer.from("flower"), o.toBuffer(), u32le(index)], program.programId)[0];
  const experimentPda = (index: number): PK => PublicKey.findProgramAddressSync(
    [Buffer.from("experiment"), owner.publicKey.toBuffer(), u32le(index)], program.programId)[0];
  const roundPda = (roundId: number): PK => PublicKey.findProgramAddressSync(
    [Buffer.from("round"), u64le(roundId)], program.programId)[0];
  const hintPda = (o: PK = owner.publicKey): PK => PublicKey.findProgramAddressSync(
    [Buffer.from("hint"), o.toBuffer()], program.programId)[0];

  // --- Arcium account sets keyed by circuit (matches breeding.devnet.ts pattern) ---
  const arciumAccountsFor = (circuit: string, computationOffset: BN) => ({
    computationAccount: arcium.getComputationAccAddress(arciumEnv.arciumClusterOffset, computationOffset),
    clusterAccount,
    mxeAccount: arcium.getMXEAccAddress(program.programId),
    mempoolAccount: arcium.getMempoolAccAddress(arciumEnv.arciumClusterOffset),
    executingPool: arcium.getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
    compDefAccount: arcium.getCompDefAccAddress(
      program.programId, Buffer.from(arcium.getCompDefAccOffset(circuit)).readUInt32LE()),
  });

  // Shared state captured in `before` / test 1, consumed by later tests.
  let mxePublicKey: Uint8Array;
  let breedCipher: arcium.RescueCipher; // for the breed fallback only
  let breedPriv: Uint8Array;
  let roundId: number;
  let targetTraits: number[];
  let targetTraitCount: number;
  let targetFlowerIndex: number;
  let firstBitmask: number;
  let firstComputedAt: number;

  // ---- HTTP-only send + confirm (no WebSocket) --------------------------------------
  async function sendTxHttp(
    tx: anchor.web3.Transaction, label: string, signers: anchor.web3.Keypair[] = [owner],
  ): Promise<{ sig: string }> {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const bh = await conn.getLatestBlockhash({ commitment: "confirmed" });
      tx.recentBlockhash = bh.blockhash;
      tx.lastValidBlockHeight = bh.lastValidBlockHeight;
      tx.feePayer = signers[0].publicKey;
      tx.signatures = [];
      tx.sign(...signers);
      let sig: string;
      try {
        sig = await conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: true, maxRetries: 0, preflightCommitment: "confirmed",
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
          if (st.err) throw new Error(`${label} tx FAILED on-chain: ${JSON.stringify(st.err)} (sig ${sig})`);
          if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return { sig };
        }
        const h = await conn.getBlockHeight({ commitment: "confirmed" });
        if (h > bh.lastValidBlockHeight) break;
        await sleep(800);
      }
      console.log(`    ${label} not confirmed (attempt ${attempt}); retrying`);
    }
    throw new Error(`${label} failed to confirm after retries`);
  }

  // ---- round lifecycle helpers ------------------------------------------------------
  async function ensureOpenRound(): Promise<number> {
    const cfg = await program.account.gameConfig.fetch(configPda);
    const cur = cfg.currentRound.toNumber();
    if (cur >= 1) {
      const info = await conn.getAccountInfo(roundPda(cur));
      if (info) {
        const r = await program.account.competitionRound.fetch(roundPda(cur));
        if (r.status === ROUND_STATUS_OPEN) {
          console.log(`[setup] reusing OPEN round ${cur}`);
          return cur;
        }
        if (r.status === ROUND_STATUS_CLOSED) {
          const tx = await program.methods.finalizeRound()
            .accountsPartial({ authority: owner.publicKey, config: configPda, round: roundPda(cur) })
            .transaction();
          await sendTxHttp(tx, `finalizeRound(${cur})`);
          console.log(`[setup] finalized CLOSED round ${cur} to open a fresh one`);
        }
      }
    }
    const newId = cur + 1;
    const tx = await program.methods.openRound()
      .accountsPartial({
        authority: owner.publicKey, config: configPda,
        previousRound: cur > 0 ? roundPda(cur) : null,
        round: roundPda(newId),
      })
      .transaction();
    await sendTxHttp(tx, `openRound(${newId})`);
    console.log(`[setup] opened round ${newId}`);
    return newId;
  }

  // ---- flower selection: prefer an existing Active ENCRYPTED hybrid, else breed one --
  async function findActiveEncryptedHybrid(): Promise<number | null> {
    const profile = await program.account.playerProfile.fetch(profilePda());
    const n = profile.nextFlowerIndex;
    // Hybrids start at index STARTER_COUNT; starters (0..5) are never Encrypted.
    for (let i = STARTER_COUNT; i < n; i++) {
      const f = await program.account.flowerRecord.fetchNullable(flowerPda(i));
      if (f && f.genomeStatus === GENOME_STATUS_ENCRYPTED && f.status === FLOWER_STATUS_ACTIVE) return i;
    }
    return null;
  }

  async function breedOneHybrid(): Promise<number> {
    const profile = await program.account.playerProfile.fetch(profilePda());
    const experiment = experimentPda(profile.totalExperiments);
    const offspring = flowerPda(profile.nextFlowerIndex);
    const offspringIndex = profile.nextFlowerIndex;
    const offset = new BN(randomBytes(8), "hex");
    const nonce = randomBytes(16);
    const ct = breedCipher.encrypt([BigInt(40), BigInt(120), BigInt(200)], nonce);
    const x25519PubBreed = arcium.x25519.getPublicKey(breedPriv);

    const tx = await program.methods
      .startBreeding(offset, Array.from(x25519PubBreed),
        new BN(arcium.deserializeLE(nonce).toString()),
        Array.from(ct[0]), Array.from(ct[1]), Array.from(ct[2]))
      .accountsPartial({
        player: owner.publicKey, profile: profilePda(),
        flowerA: flowerPda(0), flowerB: flowerPda(1),
        experiment, offspring, ...arciumAccountsFor("breed", offset),
      })
      .transaction();
    await sendTxHttp(tx, "startBreeding(0,1) [hybrid fallback]");
    await arcium.awaitComputationFinalization(provider, offset, program.programId, "confirmed", 360000);

    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      const exp = await program.account.experiment.fetch(experiment);
      if (exp.status === EXPERIMENT_STATUS_COMPLETED) break;
      if (exp.status !== EXPERIMENT_STATUS_QUEUED) throw new Error(`breed resolved to status ${exp.status}`);
      await sleep(1000);
    }
    console.log(`[setup] bred fallback hybrid at index ${offspringIndex}`);
    return offspringIndex;
  }

  // ---- hint helpers -----------------------------------------------------------------
  async function queueHint(flowerIndex: number, hintPub: Uint8Array): Promise<BN> {
    const offset = new BN(randomBytes(8), "hex");
    // A bare `Shared` sealing recipient is (pubkey, nonce): supply a fresh sealing nonce.
    // The MPC seals the output under this nonce and echoes it back in HintResult.nonce, so
    // the client decrypts with the stored nonce (no need to keep this one).
    const hintNonce = randomBytes(16);
    const tx = await program.methods
      .queuePrivateHint(offset, Array.from(hintPub), new BN(arcium.deserializeLE(hintNonce).toString()))
      .accountsPartial({
        player: owner.publicKey,
        round: roundPda(roundId),
        flower: flowerPda(flowerIndex),
        hintResult: hintPda(),
        ...arciumAccountsFor("private_hint", offset),
      })
      .transaction();
    await sendTxHttp(tx, `queuePrivateHint(flower ${flowerIndex})`);
    return offset;
  }

  async function waitForHintReady(maxMs = 180000):
    Promise<Awaited<ReturnType<typeof program.account.hintResult.fetch>>> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const h = await program.account.hintResult.fetchNullable(hintPda());
      if (h && h.ready) return h;
      await sleep(1500);
    }
    throw new Error("HintResult did not become ready in time");
  }

  before(async function () {
    this.timeout(900000);

    // GameConfig: read-only (already initialized on devnet); operator must be authority.
    const cfg = await program.account.gameConfig.fetch(configPda);
    if (!cfg.authority.equals(owner.publicKey)) {
      throw new Error(`GameConfig authority ${cfg.authority.toBase58()} != operator ${owner.publicKey.toBase58()}`);
    }
    if (cfg.paused) throw new Error("GameConfig is paused; unpause before running the hint gate");
    console.log(`[setup] GameConfig ok (authority ok, paused=${cfg.paused}, round=${cfg.currentRound})`);

    // PlayerProfile + starters: create only if missing.
    if (!(await conn.getAccountInfo(profilePda()))) {
      const tx = await program.methods.createProfile()
        .accountsPartial({ owner: owner.publicKey, config: configPda, profile: profilePda() })
        .transaction();
      await sendTxHttp(tx, "createProfile");
    }
    console.log(`[setup] PlayerProfile present`);
    if (!(await conn.getAccountInfo(flowerPda(0)))) {
      const tx = await program.methods.claimStarters()
        .accountsPartial({
          owner: owner.publicKey, config: configPda, profile: profilePda(),
          flower0: flowerPda(0), flower1: flowerPda(1), flower2: flowerPda(2),
          flower3: flowerPda(3), flower4: flowerPda(4), flower5: flowerPda(5),
        })
        .transaction();
      await sendTxHttp(tx, "claimStarters");
    }
    console.log(`[setup] starters present`);

    // private_hint comp-def MUST already be finalized (uploaded this session).
    const arciumProgram = arcium.getArciumProgram(provider);
    const compDefPda = PublicKey.findProgramAddressSync(
      [arcium.getArciumAccountBaseSeed("ComputationDefinitionAccount"),
        program.programId.toBuffer(), arcium.getCompDefAccOffset("private_hint")],
      arcium.getArciumProgramId())[0];
    const cd: any = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPda);
    const completed = cd.circuitSource?.onChain?.[0]?.isCompleted;
    if (!completed) {
      throw new Error(`private_hint comp-def NOT finalized (isCompleted=${completed}); run scripts/devnet-upload-circuit.ts first`);
    }
    console.log(`[setup] private_hint comp-def finalized (isCompleted=true)`);

    // MXE key exchange (used later to decrypt the sealed hint; and a throwaway breed cipher).
    let key: Uint8Array | null = null;
    for (let i = 0; i < 60; i++) {
      try { const k = await arcium.getMXEPublicKey(provider, program.programId); if (k) { key = k; break; } }
      catch { /* not ready */ }
      await sleep(1000);
    }
    if (!key) throw new Error("MXE public key unavailable after retries");
    mxePublicKey = key;
    breedPriv = arcium.x25519.utils.randomSecretKey();
    breedCipher = new arcium.RescueCipher(arcium.x25519.getSharedSecret(breedPriv, mxePublicKey));
    console.log(`[setup] MXE pubkey acquired; key exchange ready`);

    // Ensure an OPEN round and capture its public target traits.
    roundId = await ensureOpenRound();
    const round = await program.account.competitionRound.fetch(roundPda(roundId));
    targetTraits = Array.from(round.targetTraits);
    targetTraitCount = round.targetTraitCount;
    const names = targetTraits.slice(0, targetTraitCount).map((id) => `${id}:${TRAIT_TABLE[id] ?? "?"}`);
    console.log(`[setup] round ${roundId} OPEN; target_trait_count=${targetTraitCount} traits=[${names.join(", ")}]`);

    // Choose a flower with a REAL encrypted genome (breed one only if none exists).
    const existing = await findActiveEncryptedHybrid();
    targetFlowerIndex = existing ?? (await breedOneHybrid());
    const f = await program.account.flowerRecord.fetch(flowerPda(targetFlowerIndex));
    expect(f.genomeStatus, "target flower must be Encrypted").to.equal(GENOME_STATUS_ENCRYPTED);
    expect(f.status, "target flower must be Active").to.equal(FLOWER_STATUS_ACTIVE);
    expect(f.encryptedGenome.some((b: number) => b !== 0), "target flower genome non-zero").to.equal(true);
    console.log(`[setup] target flower index ${targetFlowerIndex} (${flowerPda(targetFlowerIndex).toBase58()}) — Active + Encrypted. Ready.`);
  });

  it("1) queue_private_hint -> MPC seals bitmask -> client decrypts (live cluster 456)", async function () {
    this.timeout(300000);

    // Fresh, ephemeral x25519 keypair — the sealing recipient (same primitive as startBreeding).
    const hintPriv = arcium.x25519.utils.randomSecretKey();
    const hintPub = arcium.x25519.getPublicKey(hintPriv);

    const offset = await queueHint(targetFlowerIndex, hintPub);
    console.log(`  [1] queued; awaiting MPC finalization...`);
    await arcium.awaitComputationFinalization(provider, offset, program.programId, "confirmed", 240000);
    const hint = await waitForHintReady();

    // The result was sealed against THIS request's round + trait count.
    expect(hint.ready).to.equal(true);
    expect(hint.player.equals(owner.publicKey)).to.equal(true);
    expect(hint.roundId.toNumber(), "hint round_id matches the round queued against").to.equal(roundId);
    expect(hint.targetTraitCount, "hint target_trait_count matches the round").to.equal(targetTraitCount);
    expect(hint.computedAt.toNumber(), "computed_at stamped").to.be.greaterThan(0);

    // Decrypt exactly like Arcium's canonical sealed-output recipient (see
    // share_medical_records example): shared secret = getSharedSecret(ourPrivKey, MXE pubkey),
    // and the nonce is the MXE-assigned OUTPUT nonce stored on-chain (NOT the one we supplied).
    // The output's `encryption_key` field is the RECIPIENT's own pubkey echoed back (an
    // identifier of who it was sealed for) — it is NOT used to derive the shared secret.
    const storedEncKey = Buffer.from(hint.encryptionKey);
    console.log(`  [1] encryption_key == our client pubkey (hintPub): ${storedEncKey.equals(Buffer.from(hintPub))}`);
    console.log(`  [1] encryption_key == live MXE pubkey:            ${storedEncKey.equals(Buffer.from(mxePublicKey))}`);

    const cipher = new arcium.RescueCipher(arcium.x25519.getSharedSecret(hintPriv, mxePublicKey));
    const decrypted = cipher.decrypt([Array.from(hint.ciphertext)], Uint8Array.from(hint.nonce));
    const bitmask = Number(decrypted[0]);
    console.log(`  [1] DECRYPTED bitmask = ${bitmask} (0b${bitmask.toString(2).padStart(targetTraitCount, "0")})`);

    // Correctness invariants from the circuit: only bits 0..target_trait_count may be set.
    expect(Number.isInteger(bitmask) && bitmask >= 0, "bitmask is a non-negative integer").to.equal(true);
    expect(bitmask, `only the ${targetTraitCount} active low bits may be set`).to.be.below(1 << targetTraitCount);
    expect(popcount(bitmask), "matched count <= target_trait_count").to.be.at.most(targetTraitCount);

    // Human-readable per-trait breakdown (the client-side decode of the 1-byte mask).
    console.log(`  [1] per-trait result for round ${roundId}:`);
    for (let i = 0; i < targetTraitCount; i++) {
      const id = targetTraits[i];
      const matched = ((bitmask >>> i) & 1) === 1;
      console.log(`        bit ${i}  trait ${id} (${TRAIT_TABLE[id] ?? "?"})  -> ${matched ? "MATCHED ✓" : "not matched ✗"}`);
    }
    const matchedNames = targetTraits.slice(0, targetTraitCount)
      .filter((_, i) => ((bitmask >>> i) & 1) === 1).map((id) => TRAIT_TABLE[id] ?? `#${id}`);
    console.log(`  [1] PASS — sealed round-trip OK. matched ${popcount(bitmask)}/${targetTraitCount}: [${matchedNames.join(", ")}]`);

    firstBitmask = bitmask;
    firstComputedAt = hint.computedAt.toNumber();
  });

  it("2) re-queue same flower OVERWRITES the one HintResult PDA (not duplicated) + is deterministic", async function () {
    this.timeout(300000);

    const pdaBefore = hintPda();
    const before = await program.account.hintResult.fetch(pdaBefore);
    expect(before.computedAt.toNumber()).to.equal(firstComputedAt);

    // A second request with a DIFFERENT fresh key. Same flower + same round -> the circuit is
    // deterministic (no RNG in private_hint), so the decrypted bitmask must match test 1.
    const hintPriv2 = arcium.x25519.utils.randomSecretKey();
    const hintPub2 = arcium.x25519.getPublicKey(hintPriv2);

    const offset = await queueHint(targetFlowerIndex, hintPub2);
    console.log(`  [2] re-queued; awaiting MPC finalization...`);
    await arcium.awaitComputationFinalization(provider, offset, program.programId, "confirmed", 240000);

    // Poll until the SAME PDA is overwritten with a newer result (computed_at advances).
    const deadline = Date.now() + 180000;
    let after = await program.account.hintResult.fetch(pdaBefore);
    while (after.computedAt.toNumber() <= firstComputedAt && Date.now() < deadline) {
      await sleep(1500);
      after = await program.account.hintResult.fetch(pdaBefore);
    }

    // Same PDA (one-per-player by construction: seeds = [b"hint", player]), overwritten in place.
    expect(hintPda().equals(pdaBefore), "hint PDA is stable per player").to.equal(true);
    expect(after.ready).to.equal(true);
    expect(after.computedAt.toNumber(), "computed_at advanced -> overwritten, not stale").to.be.greaterThan(firstComputedAt);

    // Definitive "not duplicated": exactly ONE HintResult account is owned by this player.
    const all = await program.account.hintResult.all([
      { memcmp: { offset: 8, bytes: owner.publicKey.toBase58() } }, // player is the first field
    ]);
    expect(all.length, "exactly one HintResult account per player").to.equal(1);
    expect(all[0].publicKey.equals(pdaBefore)).to.equal(true);

    const cipher2 = new arcium.RescueCipher(arcium.x25519.getSharedSecret(hintPriv2, mxePublicKey));
    const bitmask2 = Number(cipher2.decrypt([Array.from(after.ciphertext)], Uint8Array.from(after.nonce))[0]);
    console.log(`  [2] re-decrypted bitmask = ${bitmask2} (was ${firstBitmask} in test 1)`);
    expect(bitmask2, "deterministic: same flower+round -> same bitmask").to.equal(firstBitmask);
    console.log(`  [2] PASS — single HintResult PDA overwritten in place; result deterministic`);
  });

  it("3) negative — queue_private_hint on a flower NOT owned by the caller is rejected (FlowerNotOwned)", async function () {
    this.timeout(180000);

    // Stand up a SECOND wallet that owns its own starter flower 0, then have `owner` (the
    // signer) try to request a hint for THAT flower. The flower.owner == player guard must
    // reject it. On devnet the Arcium accounts exist, so the explicit constraint is actually
    // reached (unlike bankrun) — this is the first LIVE check of the ownership guard.
    const other = Keypair.generate();
    const fundTx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: other.publicKey, lamports: 100_000_000 }));
    await sendTxHttp(fundTx, "fund second wallet");
    await sendTxHttp(await program.methods.createProfile()
      .accountsPartial({ owner: other.publicKey, config: configPda, profile: profilePda(other.publicKey) })
      .transaction(), "createProfile(other)", [other]);
    await sendTxHttp(await program.methods.claimStarters()
      .accountsPartial({
        owner: other.publicKey, config: configPda, profile: profilePda(other.publicKey),
        flower0: flowerPda(0, other.publicKey), flower1: flowerPda(1, other.publicKey),
        flower2: flowerPda(2, other.publicKey), flower3: flowerPda(3, other.publicKey),
        flower4: flowerPda(4, other.publicKey), flower5: flowerPda(5, other.publicKey),
      })
      .transaction(), "claimStarters(other)", [other]);

    const hintPub = arcium.x25519.getPublicKey(arcium.x25519.utils.randomSecretKey());
    const offset = new BN(randomBytes(8), "hex");
    let rejected = false;
    try {
      // Preflight simulation surfaces the parsed constraint error without landing a tx.
      await program.methods
        .queuePrivateHint(offset, Array.from(hintPub), new BN(arcium.deserializeLE(randomBytes(16)).toString()))
        .accountsPartial({
          player: owner.publicKey,
          round: roundPda(roundId),
          flower: flowerPda(0, other.publicKey), // owned by `other`, not `owner`
          hintResult: hintPda(),
          ...arciumAccountsFor("private_hint", offset),
        })
        .signers([owner])
        .rpc({ commitment: "confirmed" });
    } catch (e) {
      rejected = true;
      expect(String(e)).to.contain("FlowerNotOwned");
    }
    expect(rejected, "hint on another wallet's flower must be rejected").to.equal(true);
    console.log(`  [3] PASS — ownership guard enforced live: FlowerNotOwned on a foreign flower`);
  });
});
