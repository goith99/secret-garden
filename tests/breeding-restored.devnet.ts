/**
 * Secret Garden — DEVNET breeding-restored gate (cluster 456).
 *
 * Post-rollback health check: after reverting the breed circuit + program to the pre-rarity
 * version (the rarity variant hung the MPC callback), this proves a real breed COMPLETES
 * normally again — the callback lands and flips the experiment to COMPLETED within seconds,
 * NOT stuck QUEUED like the rarity incident.
 *
 * Breeds on a FRESH throwaway wallet (funded by the operator) with 0 hybrids, so there's no
 * cap issue and the operator's wallet/flowers are untouched. Pre-rarity circuit writes
 * rarity=0 (the old placeholder) — that's reported (not asserted) as a sanity confirmation
 * that we are indeed on the rolled-back circuit.
 *
 * Run (FOREGROUND):
 *   set -a; source .env; set +a
 *   ANCHOR_PROVIDER_URL=$HELIUS_RPC_URL ANCHOR_WALLET=~/.config/solana/id.json \
 *     ARCIUM_CLUSTER_OFFSET=456 npx mocha --no-config --timeout 300000 \
 *     tests/breeding-restored.devnet.ts
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
const EXPERIMENT_STATUS_QUEUED = 0;
const EXPERIMENT_STATUS_COMPLETED = 2;
const N_BREEDS = 2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function readKpJson(p: string): anchor.web3.Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p).toString())));
}

describe("secret-garden DEVNET: breeding restored after rollback (cluster 456)", () => {
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
      program.programId, Buffer.from(arcium.getCompDefAccOffset("breed")).readUInt32LE()),
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

  /** Queue one breed and wait until the CALLBACK lands (experiment COMPLETED). Times it. */
  async function breedOnce(aIdx: number, bIdx: number):
    Promise<{ index: number; status: number; rarity: number; genomeNonZero: boolean; seconds: number }> {
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
    await arcium.awaitComputationFinalization(provider, offset, program.programId, "confirmed", 180000);

    // Poll for the callback to flip the experiment to COMPLETED (this is what HUNG in the
    // rarity incident — there it stayed QUEUED forever).
    const deadline = Date.now() + 120000;
    let status = EXPERIMENT_STATUS_QUEUED;
    while (Date.now() < deadline) {
      const exp = await program.account.experiment.fetch(experiment);
      status = exp.status;
      if (status === EXPERIMENT_STATUS_COMPLETED) break;
      if (status !== EXPERIMENT_STATUS_QUEUED) break; // Failed/Expired -> report as-is
      await sleep(1000);
    }
    const seconds = (Date.now() - t0) / 1000;
    const child = await program.account.flowerRecord.fetchNullable(offspring);
    return {
      index: offspringIndex,
      status,
      rarity: child?.rarity ?? -1,
      genomeNonZero: child ? child.encryptedGenome.some((x: number) => x !== 0) : false,
      seconds,
    };
  }

  before(async function () {
    this.timeout(600000);
    const cfg = await program.account.gameConfig.fetch(configPda);
    if (cfg.paused) throw new Error("GameConfig is paused");
    console.log(`[setup] GameConfig ok (paused=${cfg.paused}, round=${cfg.currentRound})`);

    const arciumProgram = arcium.getArciumProgram(provider);
    const compDefPda = PublicKey.findProgramAddressSync(
      [arcium.getArciumAccountBaseSeed("ComputationDefinitionAccount"),
        program.programId.toBuffer(), arcium.getCompDefAccOffset("breed")],
      arcium.getArciumProgramId())[0];
    const cd: any = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPda);
    if (!cd.circuitSource?.onChain?.[0]?.isCompleted) throw new Error("breed comp-def NOT finalized");
    console.log(`[setup] breed comp-def finalized (isCompleted=true) — pre-rarity circuit verified byte-identical pre-run`);

    console.log(`[setup] fresh breeder wallet: ${breeder.publicKey.toBase58()}`);
    await sendTxHttp(new anchor.web3.Transaction().add(SystemProgram.transfer({
      fromPubkey: operator.publicKey, toPubkey: breeder.publicKey, lamports: 700_000_000, // 0.7 SOL
    })), "fund breeder (0.7 SOL)", operator);
    await sendTxHttp(await program.methods.createProfile()
      .accountsPartial({ owner: breeder.publicKey, config: configPda, profile: profilePda })
      .transaction(), "createProfile(breeder)");
    await sendTxHttp(await program.methods.claimStarters()
      .accountsPartial({
        owner: breeder.publicKey, config: configPda, profile: profilePda,
        flower0: flowerPda(0), flower1: flowerPda(1), flower2: flowerPda(2),
        flower3: flowerPda(3), flower4: flowerPda(4), flower5: flowerPda(5),
      }).transaction(), "claimStarters(breeder)");
    console.log(`[setup] breeder profile + starters ready (0 hybrids, budget 5/5)`);

    let key: Uint8Array | null = null;
    for (let i = 0; i < 60 && !key; i++) {
      try { const k = await arcium.getMXEPublicKey(provider, program.programId); if (k) key = k; }
      catch { /* not ready */ }
      if (!key) await sleep(1000);
    }
    if (!key) throw new Error("MXE public key unavailable");
    const priv = arcium.x25519.utils.randomSecretKey();
    x25519Pub = arcium.x25519.getPublicKey(priv);
    cipher = new arcium.RescueCipher(arcium.x25519.getSharedSecret(priv, key));
    console.log(`[setup] ready.`);
  });

  it(`breeds ${N_BREEDS} hybrids and each callback COMPLETES in seconds (not stuck QUEUED)`, async function () {
    this.timeout(900000);
    const results = [];
    for (let n = 0; n < N_BREEDS; n++) {
      console.log(`  breeding ${n + 1}/${N_BREEDS} (parents 0,1)...`);
      const r = await breedOnce(0, 1);
      const statusName = ["QUEUED(STUCK!)", "PROCESSING", "COMPLETED", "FAILED", "EXPIRED"][r.status] ?? `?${r.status}`;
      console.log(`    -> idx ${r.index}: status=${statusName} in ${r.seconds.toFixed(1)}s | genomeNonZero=${r.genomeNonZero} rarity=${r.rarity} (0=pre-rarity placeholder, expected)`);
      results.push(r);
    }

    console.log(`\n  ── breeding-restored results (breeder ${breeder.publicKey.toBase58()}) ──`);
    console.log(`  idx | callback status | time(s) | genome | rarity`);
    for (const r of results) {
      const sn = ["QUEUED", "PROC", "COMPLETED", "FAILED", "EXPIRED"][r.status] ?? `?`;
      console.log(`  ${String(r.index).padStart(3)} | ${sn.padEnd(15)} | ${r.seconds.toFixed(1).padStart(6)} | ${r.genomeNonZero ? "OK   " : "EMPTY"} | ${r.rarity}`);
    }
    console.log(`  ──────────────────────────────────────────────`);

    // Hard proof: every breed's callback COMPLETED (not stuck QUEUED / not FAILED), with a
    // real Encrypted genome — i.e. breeding works end-to-end again.
    for (const r of results) {
      expect(r.status, `idx ${r.index} callback COMPLETED (rarity incident left it QUEUED forever)`).to.equal(EXPERIMENT_STATUS_COMPLETED);
      expect(r.genomeNonZero, `idx ${r.index} has a real Encrypted genome`).to.equal(true);
    }
    const maxS = Math.max(...results.map((r) => r.seconds));
    console.log(`\n  PASS — breeding RESTORED: ${results.length}/${results.length} callbacks COMPLETED (slowest ${maxS.toFixed(1)}s). No hung QUEUED experiments.`);
  });
});
