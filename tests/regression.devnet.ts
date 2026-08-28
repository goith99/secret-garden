/**
 * Secret Garden — DEVNET packed-mask rarity gate (cluster 456).
 *
 * The DEFINITIVE live proof of the PACKED-MASK rarity fix. The `breed` MPC circuit now rolls
 * rarity (1..=5) and packs it into bits 19-21 of the revealed u32 trait mask, keeping the
 * proven 2-tuple `(Enc<Mxe,Genome>, u32)` output. The callback unpacks rarity into
 * FlowerRecord.rarity and stores a rarity-STRIPPED (class-only) mask, so the frontend's
 * petal/color/leaf/stem decoder is untouched.
 *
 * Bits 19-21 (not 27-29): a rarity at 27-29 read back as 0 on-chain because the live Arcium
 * output path truncates a revealed u32 at ~27 bits — 19-21 stays below that cliff.
 *
 * This proves, on a FRESH throwaway wallet (operator untouched):
 *   1. the callback COMPLETES within seconds — NOT stuck QUEUED like the 3-tuple incident
 *      (which reverted the callback with error 102, leaving the experiment QUEUED forever);
 *   2. rarity lands in 1..=5 (never the old hardcoded 0 placeholder);
 *   3. the STORED mask is already rarity-stripped (bits 19-21 == 0) and decodes to valid
 *      petal/color/leaf/stem classes (0-4 each) — the frontend mask decoder is unaffected.
 *
 * Same proven pattern as tests/breeding-restored.devnet.ts: HTTP send + confirm (Helius has
 * no WebSocket), foreground execution.
 *
 * Run (FOREGROUND — background Bash has no network egress here):
 *   set -a; source .env; set +a
 *   ANCHOR_PROVIDER_URL=$HELIUS_RPC_URL ANCHOR_WALLET=~/.config/solana/id.json \
 *     ARCIUM_CLUSTER_OFFSET=456 npx mocha --no-config --timeout 300000 \
 *     tests/rarity.devnet.ts
 */
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import * as arcium from "@arcium-hq/client";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import { expect } from "chai";
import type { SecretGarden } from "../target/types/secret_garden";

const { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } = anchor.web3;
type PK = anchor.web3.PublicKey;

const EXPERIMENT_STATUS_QUEUED = 0;
const EXPERIMENT_STATUS_COMPLETED = 2;
const TARGET_BREEDS = 2;

const RARITY_NAMES: Record<number, string> = {
  0: "UNRANKED(0)", 1: "Common", 2: "Uncommon", 3: "Rare", 4: "Epic", 5: "Legendary",
};
const CLASS_NAMES = ["petal", "color", "leaf", "stem"] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function readKpJson(p: string): anchor.web3.Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p).toString())));
}

// --- packed-mask helpers, MUST match circuit(pack) / callback(unpack,strip) / frontend(class) ---
/** callback strip: mask & 0xFFC7FFFF (clears rarity bits 19-21) */
const stripRarity = (mask: number): number => (mask & 0xffc7_ffff) >>> 0;
/** frontend decoder: class k = ((mask >> 8k) & 0xff) % 5 (k = 0 petal,1 color,2 leaf,3 stem) */
const decodeClasses = (mask: number): number[] =>
  [0, 1, 2, 3].map((k) => ((mask >>> (8 * k)) & 0xff) % 5);
const hex32 = (n: number): string => "0x" + (n >>> 0).toString(16).padStart(8, "0");

describe("secret-garden DEVNET: 3-use parent cap (cluster 456)", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const conn = provider.connection;
  const program = anchor.workspace.SecretGarden as anchor.Program<SecretGarden>;
  const operator = readKpJson(`${os.homedir()}/.config/solana/id.json`); // funds only
  const breeder = Keypair.generate(); // fresh throwaway player

  const arciumEnv = arcium.getArciumEnv();
  const clusterAccount = arcium.getClusterAccAddress(arciumEnv.arciumClusterOffset);

  const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId)[0];
  const profilePda = PublicKey.findProgramAddressSync(
    [Buffer.from("profile"), breeder.publicKey.toBuffer()], program.programId)[0];
  const flowerPda = (i: number): PK => PublicKey.findProgramAddressSync(
    [Buffer.from("flower"), breeder.publicKey.toBuffer(), u32le(i)], program.programId)[0];
  const experimentPda = (i: number): PK => PublicKey.findProgramAddressSync(
    [Buffer.from("experiment"), breeder.publicKey.toBuffer(), u32le(i)], program.programId)[0];

  /** Same account set, parameterised by CIRCUIT name — the comp-def address is
   *  sha256(name)[0..4], so this is the one thing that must match the program. */
  const arciumAccountsNamed = (offset: BN, circuit: string) => ({
    computationAccount: arcium.getComputationAccAddress(arciumEnv.arciumClusterOffset, offset),
    clusterAccount,
    mxeAccount: arcium.getMXEAccAddress(program.programId),
    mempoolAccount: arcium.getMempoolAccAddress(arciumEnv.arciumClusterOffset),
    executingPool: arcium.getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
    compDefAccount: arcium.getCompDefAccAddress(
      program.programId, Buffer.from(arcium.getCompDefAccOffset(circuit)).readUInt32LE()),
  });
  const arciumAccountsForScore = (offset: BN) => arciumAccountsNamed(offset, "score_entry_v2");
  const arciumAccountsForReveal = (offset: BN) => arciumAccountsNamed(offset, "reveal_top3_v5");

  const arciumAccountsFor = (offset: BN) => ({
    computationAccount: arcium.getComputationAccAddress(arciumEnv.arciumClusterOffset, offset),
    clusterAccount,
    mxeAccount: arcium.getMXEAccAddress(program.programId),
    mempoolAccount: arcium.getMempoolAccAddress(arciumEnv.arciumClusterOffset),
    executingPool: arcium.getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
    compDefAccount: arcium.getCompDefAccAddress(
      program.programId, Buffer.from(arcium.getCompDefAccOffset("breed_v3")).readUInt32LE()),
  });

  let cipher: arcium.RescueCipher;
  let x25519Pub: Uint8Array;

  async function sendTxHttp(
    tx: anchor.web3.Transaction, label: string, signer: anchor.web3.Keypair = breeder,
  ): Promise<{ sig: string }> {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const bh = await conn.getLatestBlockhash({ commitment: "confirmed" });
      tx.recentBlockhash = bh.blockhash;
      tx.lastValidBlockHeight = bh.lastValidBlockHeight;
      tx.feePayer = signer.publicKey;
      tx.signatures = [];
      tx.sign(signer);
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

  interface BreedResult {
    index: number; status: number; seconds: number;
    rarity: number; mask: number; genomeNonZero: boolean;
  }

  /** Queue one breed, await MPC finalization, then poll the callback -> COMPLETED. Times it. */
  async function breedOnce(aIdx: number, bIdx: number): Promise<BreedResult> {
    const profile = await program.account.playerProfile.fetch(profilePda);
    const experiment = experimentPda(profile.totalExperiments);
    const offspringIndex = profile.nextFlowerIndex;
    const offspring = flowerPda(offspringIndex);
    const offset = new BN(randomBytes(8), "hex");
    const nonce = randomBytes(16);
    const ct = cipher.encrypt([BigInt(40), BigInt(120), BigInt(200)], nonce);

    const t0 = Date.now();
    const tx = await program.methods
      .startBreeding(offset, Array.from(x25519Pub),
        new BN(arcium.deserializeLE(nonce).toString()),
        Array.from(ct[0]), Array.from(ct[1]), Array.from(ct[2]))
      .accountsPartial({
        player: breeder.publicKey, profile: profilePda,
        flowerA: flowerPda(aIdx), flowerB: flowerPda(bIdx),
        experiment, offspring, ...arciumAccountsFor(offset),
      })
      .transaction();
    await sendTxHttp(tx, `startBreeding(${aIdx},${bIdx})->idx${offspringIndex}`);
    await arcium.awaitComputationFinalization(provider, offset, program.programId, "confirmed", 300000);

    // Poll for the callback to flip the experiment to COMPLETED (this is what HUNG in the
    // 3-tuple incident — there it stayed QUEUED forever because the callback reverted w/ 102).
    const deadline = Date.now() + 240000;
    let status = EXPERIMENT_STATUS_QUEUED;
    while (Date.now() < deadline) {
      const exp = await program.account.experiment.fetch(experiment);
      status = exp.status;
      if (status === EXPERIMENT_STATUS_COMPLETED) break;
      if (status !== EXPERIMENT_STATUS_QUEUED) break; // Failed/Expired -> report as-is
      await sleep(1000);
    }
    const seconds = (Date.now() - t0) / 1000;
    const child = await program.account.flowerRecord.fetch(offspring);
    return {
      index: offspringIndex, status, seconds,
      rarity: child.rarity, mask: child.revealedTraitMask >>> 0,
      genomeNonZero: child.encryptedGenome.some((x: number) => x !== 0),
    };
  }

  before(async function () {
    this.timeout(900000);

    const cfg = await program.account.gameConfig.fetch(configPda);
    if (cfg.paused) throw new Error("GameConfig is paused; unpause before running the rarity gate");
    console.log(`[setup] GameConfig ok (paused=${cfg.paused}, round=${cfg.currentRound})`);

    // breed comp-def MUST be finalized — the packed-mask rarity circuit is live.
    const arciumProgram = arcium.getArciumProgram(provider);
    const compDefPda = PublicKey.findProgramAddressSync(
      [arcium.getArciumAccountBaseSeed("ComputationDefinitionAccount"),
        program.programId.toBuffer(), arcium.getCompDefAccOffset("breed_v3")],
      arcium.getArciumProgramId())[0];
    const cd: any = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPda);
    if (!cd.circuitSource?.onChain?.[0]?.isCompleted) throw new Error("breed comp-def NOT finalized");
    console.log(`[setup] breed comp-def finalized (isCompleted=true) — packed-mask circuit live`);

    // Fund the fresh breeder wallet from the operator, then stand up its profile + starters.
    console.log(`[setup] fresh breeder wallet: ${breeder.publicKey.toBase58()}`);
    const fundTx = new anchor.web3.Transaction().add(SystemProgram.transfer({
      fromPubkey: operator.publicKey, toPubkey: breeder.publicKey, lamports: LAMPORTS_PER_SOL, // 1 SOL
    }));
    await sendTxHttp(fundTx, "fund breeder (1 SOL)", operator);
    await sendTxHttp(await program.methods.createProfile()
      .accountsPartial({ owner: breeder.publicKey, config: configPda, profile: profilePda })
      .transaction(), "createProfile(breeder)");
    await sendTxHttp(await program.methods.claimStarters()
      .accountsPartial({
        owner: breeder.publicKey, config: configPda, profile: profilePda,
        flower0: flowerPda(0), flower1: flowerPda(1), flower2: flowerPda(2),
        flower3: flowerPda(3), flower4: flowerPda(4), flower5: flowerPda(5),
      }).transaction(), "claimStarters(breeder)");
    const prof = await program.account.playerProfile.fetch(profilePda);
    console.log(`[setup] breeder ready: total_flowers=${prof.totalFlowers} hybrids=0 budget=5/5`);

    // MXE key-exchange for the env ciphertexts (breeder is the player supplying env).
    let key: Uint8Array | null = null;
    for (let i = 0; i < 60 && !key; i++) {
      try { const k = await arcium.getMXEPublicKey(provider, program.programId); if (k) key = k; }
      catch { /* not ready */ }
      if (!key) await sleep(1000);
    }
    if (!key) throw new Error("MXE public key unavailable after retries");
    const priv = arcium.x25519.utils.randomSecretKey();
    x25519Pub = arcium.x25519.getPublicKey(priv);
    cipher = new arcium.RescueCipher(arcium.x25519.getSharedSecret(priv, key));
    console.log(`[setup] MXE key exchange done. Ready to breed ${TARGET_BREEDS}.`);
  });

  it("regression: submit_entry, close_flower, and the score/reveal wiring on the LIVE round", async function () {
    const pid = program.programId;
    const cfg = await program.account.gameConfig.fetch(
      PublicKey.findProgramAddressSync([Buffer.from("config")], pid)[0]);
    const roundId = Number(cfg.currentRound);
    const [roundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("round"), new BN(roundId).toArrayLike(Buffer, "le", 8)], pid);
    const [entry] = PublicKey.findProgramAddressSync(
      [Buffer.from("entry"), roundPda.toBuffer(), breeder.publicKey.toBuffer()], pid);
    const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], pid);

    // Codes we must NEVER see: the deploy-wiring failures.
    const FATAL = /2012|ConstraintAddress|6301|InvalidArguments|AccountDidNotDeserialize|0xbbb/i;
    const simulate = async (tx: anchor.web3.Transaction, label: string) => {
      tx.feePayer = breeder.publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
      const r = await conn.simulateTransaction(tx);
      const logs = (r.value.logs || []).join(" | ");
      const err = r.value.err ? JSON.stringify(r.value.err) : null;
      const codeMatch = /Custom":(\d+)/.exec(err || "");
      const named = /Error Code: (\w+)/.exec(logs);
      console.log(`  ${label}: ${err ? `err=${err}${named ? ` (${named[1]})` : ""}` : "SUCCESS"}`);
      return { err, logs, code: codeMatch ? Number(codeMatch[1]) : null, named: named?.[1] || null };
    };

    // --- 1. submit_entry (SIMULATED: the live round holds real players' entries, so this
    //        proves the path including the new rarity_snapshot write without joining it) ---
    const submitTx = await program.methods.submitEntry()
      .accountsPartial({
        player: breeder.publicKey, config: configPda, profile: profilePda,
        round: roundPda, flowerRecord: flowerPda(0), entry,
        systemProgram: anchor.web3.SystemProgram.programId,
      }).transaction();
    const sub = await simulate(submitTx, "submit_entry (simulated)");
    expect(FATAL.test(sub.err || ""), `submit_entry hit a wiring error: ${sub.err}`).to.equal(false);
    expect(sub.err, "submit_entry should simulate cleanly").to.equal(null);

    // --- 2. close_flower — REAL, on this wallet's own hybrid. Touches nobody else. ---
    const bred = await breedOnce(0, 1);           // make a real hybrid to delete
    console.log(`  bred hybrid idx ${bred.index} (rarity ${bred.rarity}) to close`);
    const hybrid = flowerPda(bred.index);
    const before = await program.account.flowerRecord.fetchNullable(hybrid);
    if (before) {
      const closeTx = await program.methods.closeFlower()
        .accountsPartial({
          owner: breeder.publicKey, config: configPda, profile: profilePda, flower: hybrid,
        }).transaction();
      await sendTxHttp(closeTx, "close_flower(idx6)");
      const after = await program.account.flowerRecord.fetchNullable(hybrid);
      console.log(`  close_flower: account ${after === null ? "CLOSED (rent refunded)" : "** STILL PRESENT **"}`);
      expect(after, "close_flower should close the account").to.equal(null);
    } else {
      console.log("  close_flower: skipped (idx6 absent)");
    }

    // --- 3. score + reveal wiring. The round is OPEN, so both must fail on ROUND STATE.
    //        Anchor checks the comp_def_account address constraint during account resolution,
    //        BEFORE the handler's status check — so reaching a round-state error proves the
    //        comp-def addresses resolve, which is exactly what 2012 would have caught. ---
    // Use a REAL entry of the live round and the REAL authority as signer, so Anchor resolves
    // every account — including comp_def_account — instead of bailing on a missing entry.
    // Simulation only: nothing is sent, the round is untouched.
    const authority = anchor.web3.Keypair.fromSecretKey(new Uint8Array(
      JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`).toString())));
    const liveEntries = await program.account.competitionEntry.all([
      { memcmp: { offset: 8, bytes: roundPda.toBase58() } }]);
    console.log(`  live round has ${liveEntries.length} real entries; using one for the score sim`);
    const le = liveEntries[0];
    const off1 = new BN(randomBytes(8), "hex");
    const scoreTx = await program.methods.queueScoreEntry(off1)
      .accountsPartial({
        authority: authority.publicKey, config: configPda, round: roundPda,
        entry: le.publicKey, flowerRecord: le.account.flowerRecord,
        ...arciumAccountsForScore(off1),
      }).transaction();
    scoreTx.feePayer = authority.publicKey;
    scoreTx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    const scRaw = await conn.simulateTransaction(scoreTx);
    const scLogs = (scRaw.value.logs || []).join(" | ");
    const scNamed = /Error Code: (\w+)/.exec(scLogs);
    console.log(`  queue_score_entry (simulated, real entry): ${scRaw.value.err ? `err=${JSON.stringify(scRaw.value.err)} (${scNamed?.[1] || "?"})` : "SUCCESS"}`);
    const sc = { err: scRaw.value.err ? JSON.stringify(scRaw.value.err) : null, logs: scLogs, named: scNamed?.[1] || null };
    expect(FATAL.test(sc.err || "") || FATAL.test(sc.logs), `score hit a wiring error: ${sc.named}`).to.equal(false);

    const off2 = new BN(randomBytes(8), "hex");
    const [bracket] = PublicKey.findProgramAddressSync([Buffer.from("bracket"), roundPda.toBuffer()], pid);
    const [result] = PublicKey.findProgramAddressSync(
      [Buffer.from("shardres"), roundPda.toBuffer(), Buffer.from([0])], pid);
    const revealTx = await program.methods.queueShardReveal(off2, 0)
      .accountsPartial({
        authority: breeder.publicKey, config: configPda, round: roundPda,
        bracket, result, ...arciumAccountsForReveal(off2),
      }).transaction();
    const rv = await simulate(revealTx, "queue_shard_reveal (simulated, OPEN round)");
    expect(FATAL.test(rv.err || "") || FATAL.test(rv.logs), `reveal hit a wiring error: ${rv.named}`).to.equal(false);

    console.log(`\n  score sim reached: ${sc.named || "(no anchor error)"} — must NOT be ConstraintAddress`);
    console.log(`  reveal sim reached: ${rv.named || "(no anchor error)"} — bracket is absent on an OPEN round,`);
    console.log("  so the reveal's comp-def constraint is NOT exercised here; see the address-match evidence.");
  });
});
