/**
 * Secret Garden — DEVNET scoring gate (cluster 456).
 *
 * Proves the Enc<Mxe>-via-account() round-trip works on devnet for the OTHER two
 * circuits — score_entry and reveal_top3 — the same way tests/breeding.devnet.ts proved
 * it for breed. It runs a minimal single-entrant competition round end-to-end against
 * the LIVE deployment, reusing an already-bred encrypted flower owned by the operator:
 *
 *   openRound -> submitEntry -> closeRound
 *   -> queueScoreEntry   (score_entry MPC reads the flower's Enc<Mxe> genome via
 *                         ArgBuilder::account(); callback persists `scored`)   [GATE A]
 *   -> queueRevealTop3   (reveal_top3 MPC reads the entry's stored score via
 *                         account(); callback sets `scoringRevealed`/top1)     [GATE B]
 *   -> finalizeRound
 *
 * Same devnet realities as breeding.devnet.ts: Helius RPC has no working WebSocket, so
 * every must-land tx is sent + confirmed over HTTP polling (not Anchor `.rpc()`);
 * awaitComputationFinalization already polls over HTTP and is used as-is.
 *
 * Setup is IDEMPOTENT/read-only: GameConfig already exists, all three comp-defs are
 * already finalized on-chain, and the operator already owns encrypted flowers (6..9 from
 * the breeding gate). This test does NOT init config or upload circuits.
 *
 * Run:
 *   set -a; source .env; set +a
 *   ANCHOR_PROVIDER_URL=$HELIUS_RPC_URL ANCHOR_WALLET=~/.config/solana/id.json \
 *     ARCIUM_CLUSTER_OFFSET=456 npx mocha --no-config --timeout 1800000 \
 *     tests/scoring.devnet.ts
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
type KP = anchor.web3.Keypair;

const GENOME_STATUS_ENCRYPTED = 1;
const FLOWER_STATUS_ACTIVE = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64le = (n: number | bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
function readKpJson(p: string): KP {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p).toString())));
}

describe("secret-garden DEVNET: scoring gate (cluster 456)", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const conn = provider.connection;
  const program = anchor.workspace.SecretGarden as anchor.Program<SecretGarden>;
  const authority = readKpJson(`${os.homedir()}/.config/solana/id.json`);
  const owner = authority; // operator is both authority and the single entrant here

  const arciumEnv = arcium.getArciumEnv();
  const clusterAccount = arcium.getClusterAccAddress(arciumEnv.arciumClusterOffset);
  const mxeAccount = arcium.getMXEAccAddress(program.programId);

  const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId)[0];
  const profilePda = (o: PK) => PublicKey.findProgramAddressSync(
    [Buffer.from("profile"), o.toBuffer()], program.programId)[0];
  const flowerPda = (o: PK, i: number) => PublicKey.findProgramAddressSync(
    [Buffer.from("flower"), o.toBuffer(), u32le(i)], program.programId)[0];
  const roundPda = (id: number) => PublicKey.findProgramAddressSync(
    [Buffer.from("round"), u64le(id)], program.programId)[0];
  const entryPda = (round: PK, player: PK) => PublicKey.findProgramAddressSync(
    [Buffer.from("entry"), round.toBuffer(), player.toBuffer()], program.programId)[0];

  const freshOffset = () => new BN(randomBytes(8), "hex");
  const compDefAccOf = (circuit: string) => arcium.getCompDefAccAddress(
    program.programId, Buffer.from(arcium.getCompDefAccOffset(circuit)).readUInt32LE());
  const queueAccsFor = (circuit: string, offset: BN) => ({
    computationAccount: arcium.getComputationAccAddress(arciumEnv.arciumClusterOffset, offset),
    clusterAccount,
    mxeAccount,
    mempoolAccount: arcium.getMempoolAccAddress(arciumEnv.arciumClusterOffset),
    executingPool: arcium.getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
    compDefAccount: compDefAccOf(circuit),
  });

  // ---- HTTP-only send + confirm (no WebSocket on this Helius endpoint) ----
  async function sendTxHttp(tx: anchor.web3.Transaction, label: string): Promise<string> {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const bh = await conn.getLatestBlockhash({ commitment: "confirmed" });
      tx.recentBlockhash = bh.blockhash;
      tx.lastValidBlockHeight = bh.lastValidBlockHeight;
      tx.feePayer = authority.publicKey;
      tx.signatures = [];
      tx.sign(authority);
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
          if (st.err) throw new Error(`${label} tx FAILED: ${JSON.stringify(st.err)} (sig ${sig})`);
          if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return sig;
        }
        const h = await conn.getBlockHeight({ commitment: "confirmed" });
        if (h > bh.lastValidBlockHeight) break;
        await sleep(800);
      }
      console.log(`    ${label} not confirmed (attempt ${attempt}); retrying`);
    }
    throw new Error(`${label} failed to confirm after retries`);
  }

  let entryFlower: PK;

  before(async function () {
    this.timeout(300_000);
    // GameConfig must already exist with operator as authority.
    const cfg = await program.account.gameConfig.fetch(configPda);
    if (!cfg.authority.equals(authority.publicKey)) throw new Error("config authority != operator");
    console.log(`[setup] GameConfig: authority ok, paused=${cfg.paused}, currentRound=${cfg.currentRound}`);

    // All three comp-defs must be finalized on-chain (uploaded this session).
    const arciumProgram = arcium.getArciumProgram(provider);
    for (const c of ["score_entry", "reveal_top3"] as const) {
      const pda = PublicKey.findProgramAddressSync(
        [arcium.getArciumAccountBaseSeed("ComputationDefinitionAccount"),
          program.programId.toBuffer(), arcium.getCompDefAccOffset(c)],
        arcium.getArciumProgramId())[0];
      const cd: any = await arciumProgram.account.computationDefinitionAccount.fetch(pda);
      const done = cd.circuitSource?.onChain?.[0]?.isCompleted;
      if (!done) throw new Error(`${c} comp-def NOT finalized (isCompleted=${done})`);
      console.log(`[setup] ${c} comp-def finalized=true`);
    }

    // Pick an existing encrypted, active flower owned by the operator (6..9 from breeding gate).
    entryFlower = null as unknown as PK;
    for (let i = 6; i <= 11; i++) {
      try {
        const f: any = await program.account.flowerRecord.fetch(flowerPda(owner.publicKey, i));
        if (f.status === FLOWER_STATUS_ACTIVE && f.genomeStatus === GENOME_STATUS_ENCRYPTED) {
          entryFlower = flowerPda(owner.publicKey, i);
          console.log(`[setup] using encrypted flower index ${i}: ${entryFlower.toBase58()}`);
          break;
        }
      } catch { /* not present */ }
    }
    if (!entryFlower) throw new Error("no encrypted flower available to submit");
  });

  async function openRound(): Promise<number> {
    const cfg = await program.account.gameConfig.fetch(configPda);
    const current = cfg.currentRound.toNumber();
    const tx = await program.methods.openRound()
      .accountsPartial({
        authority: authority.publicKey, config: configPda,
        previousRound: current > 0 ? roundPda(current) : null,
        round: roundPda(current + 1),
      }).transaction();
    await sendTxHttp(tx, `openRound(${current + 1})`);
    return current + 1;
  }

  it("score_entry + reveal_top3 Enc<Mxe> round-trip on cluster 456", async function () {
    this.timeout(900_000);

    const roundId = await openRound();
    const round = roundPda(roundId);
    const entry = entryPda(round, owner.publicKey);
    console.log(`  round ${roundId} opened (${round.toBase58()})`);

    // submit
    const submitTx = await program.methods.submitEntry()
      .accountsPartial({
        player: owner.publicKey, profile: profilePda(owner.publicKey),
        round, flowerRecord: entryFlower, entry,
      }).transaction();
    await sendTxHttp(submitTx, "submitEntry");
    console.log(`  entry submitted (${entry.toBase58()})`);

    // close
    const closeTx = await program.methods.closeRound()
      .accountsPartial({ authority: authority.publicKey, round }).transaction();
    await sendTxHttp(closeTx, "closeRound");

    // ---- GATE A: score_entry (reads flower Enc<Mxe> genome via account()) ----
    const scoreOffset = freshOffset();
    const scoreTx = await program.methods.queueScoreEntry(scoreOffset)
      .accountsPartial({
        authority: authority.publicKey, round, entry, flowerRecord: entryFlower,
        ...queueAccsFor("score_entry", scoreOffset),
      }).transaction();
    await sendTxHttp(scoreTx, "queueScoreEntry");
    console.log(`  [score_entry] queued; awaiting MPC finalization...`);
    await arcium.awaitComputationFinalization(provider, scoreOffset, program.programId, "confirmed", 360000);

    let scored = false;
    for (let i = 0; i < 120; i++) {
      if ((await program.account.competitionEntry.fetch(entry)).scored) { scored = true; break; }
      await sleep(1000);
    }
    expect(scored, "competition entry must be scored by the callback").to.equal(true);
    const entryAcc: any = await program.account.competitionEntry.fetch(entry);
    console.log(`  [score_entry] PASS — entry.scored=true; entry keys: ${Object.keys(entryAcc).join(",")}`);

    // ---- GATE B: reveal_top3 (reads entry's stored score via account()) ----
    const revealOffset = freshOffset();
    const revealTx = await program.methods.queueRevealTop3(revealOffset)
      .accountsPartial({ authority: authority.publicKey, round, ...queueAccsFor("reveal_top3", revealOffset) })
      .remainingAccounts([{ pubkey: entry, isWritable: false, isSigner: false }])
      .transaction();
    await sendTxHttp(revealTx, "queueRevealTop3");
    console.log(`  [reveal_top3] queued; awaiting MPC finalization...`);
    await arcium.awaitComputationFinalization(provider, revealOffset, program.programId, "confirmed", 360000);

    let revealed = false;
    for (let i = 0; i < 120; i++) {
      if ((await program.account.competitionRound.fetch(round)).scoringRevealed) { revealed = true; break; }
      await sleep(1000);
    }
    expect(revealed, "round must be revealed by the callback").to.equal(true);
    const r: any = await program.account.competitionRound.fetch(round);
    expect(r.top1.equals(entry), "top1 must be the single real entry").to.equal(true);
    console.log(`  [reveal_top3] PASS — scoringRevealed=true, scoredCount=${r.scoredCount}, top1=${r.top1.toBase58()}`);

    // cleanup so a future round can open
    const finTx = await program.methods.finalizeRound()
      .accountsPartial({ authority: authority.publicKey, round }).transaction();
    await sendTxHttp(finTx, "finalizeRound");
    console.log(`  round ${roundId} finalized`);
  });
});
