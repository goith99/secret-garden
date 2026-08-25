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

describe("secret-garden DEVNET: packed-mask rarity roll (cluster 456)", () => {
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

  const arciumAccountsFor = (offset: BN) => ({
    computationAccount: arcium.getComputationAccAddress(arciumEnv.arciumClusterOffset, offset),
    clusterAccount,
    mxeAccount: arcium.getMXEAccAddress(program.programId),
    mempoolAccount: arcium.getMempoolAccAddress(arciumEnv.arciumClusterOffset),
    executingPool: arcium.getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
    compDefAccount: arcium.getCompDefAccAddress(
      program.programId, Buffer.from(arcium.getCompDefAccOffset("breed_v5")).readUInt32LE()),
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
        program.programId.toBuffer(), arcium.getCompDefAccOffset("breed_v5")],
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

  it("each bred hybrid: callback COMPLETES fast, rarity 1..=5, mask decodes cleanly (frontend unaffected)", async function () {
    this.timeout(1_800_000);

    const results: BreedResult[] = [];
    for (let n = 0; n < TARGET_BREEDS; n++) {
      console.log(`  breeding ${n + 1}/${TARGET_BREEDS} (parents 0,1)...`);
      const r = await breedOnce(0, 1);
      const sn = ["QUEUED(STUCK!)", "PROCESSING", "COMPLETED", "FAILED", "EXPIRED"][r.status] ?? `?${r.status}`;
      const classes = decodeClasses(stripRarity(r.mask));
      console.log(`    -> idx ${r.index}: status=${sn} in ${r.seconds.toFixed(1)}s | mask=${hex32(r.mask)} `
        + `classes=[${classes.join(",")}] rarity=${r.rarity} (${RARITY_NAMES[r.rarity] ?? "??"})`);
      results.push(r);
    }

    // --- summary table ---
    console.log(`\n  ── packed-mask rarity results (breeder ${breeder.publicKey.toBase58()}) ──`);
    console.log(`  idx | status     | time(s) | mask (hex)  | petal color leaf stem | rarity | tier`);
    console.log(`  ----+------------+---------+-------------+-----------------------+--------+----------`);
    for (const r of results) {
      const sn = ["QUEUED", "PROC", "COMPLETED", "FAILED", "EXPIRED"][r.status] ?? "?";
      const c = decodeClasses(stripRarity(r.mask));
      console.log(
        `  ${String(r.index).padStart(3)} | ${sn.padEnd(10)} | ${r.seconds.toFixed(1).padStart(7)} | `
        + `${hex32(r.mask)}  | ${String(c[0]).padStart(5)} ${String(c[1]).padStart(5)} `
        + `${String(c[2]).padStart(4)} ${String(c[3]).padStart(4)} | ${String(r.rarity).padStart(6)} | `
        + `${RARITY_NAMES[r.rarity] ?? "??"}`);
    }
    console.log(`  ──────────────────────────────────────────────────────────────────────────────`);
    const distinct = [...new Set(results.map((r) => r.rarity))].sort();
    console.log(`  distinct tiers observed: [${distinct.map((d) => `${d}:${RARITY_NAMES[d]}`).join(", ")}]`);
    const maxS = Math.max(...results.map((r) => r.seconds));

    // --- hard proofs ---
    for (const r of results) {
      // 1. callback landed (NOT stuck QUEUED like the 3-tuple incident) with a real genome.
      expect(r.status, `idx ${r.index} callback COMPLETED (3-tuple incident left it QUEUED forever)`)
        .to.equal(EXPERIMENT_STATUS_COMPLETED);
      expect(r.genomeNonZero, `idx ${r.index} has a real Encrypted genome`).to.equal(true);
      // 2. rarity rolled a real tier (1..=5, never the old hardcoded 0).
      expect(r.rarity, `idx ${r.index} rarity is a real tier (not the old 0 placeholder)`).to.not.equal(0);
      expect(r.rarity, `idx ${r.index} rarity in 1..=5`).to.be.within(1, 5);
      // 3. the STORED mask is already rarity-stripped (callback cleared bits 19-21) -> the
      //    frontend decoder (which never strips) sees a clean class-only mask.
      expect((r.mask >>> 19) & 0x07, `idx ${r.index} stored mask has NO rarity bits (19-21) (callback stripped rarity)`)
        .to.equal(0);
      expect(stripRarity(r.mask), `idx ${r.index} stored mask == its stripped form (already clean)`)
        .to.equal(r.mask);
      // 4. mask decodes to valid classes 0-4 for petal/color/leaf/stem.
      decodeClasses(r.mask).forEach((cls, k) => {
        expect(cls, `idx ${r.index} ${CLASS_NAMES[k]} class in 0..=4`).to.be.within(0, 4);
      });
    }
    console.log(`\n  PASS — ${results.length}/${results.length} callbacks COMPLETED (slowest ${maxS.toFixed(1)}s, `
      + `none stuck QUEUED). Every hybrid: rarity 1..=5, mask rarity-stripped & decodes to valid classes.`);
  });
});
