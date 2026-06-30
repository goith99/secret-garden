/**
 * Secret Garden — DAILY AUTO-CYCLE (Railway cron, DEVNET cluster 456).
 *
 * A single standalone Node script (NOT a mocha test) that runs the full daily round
 * cycle end-to-end, in order:
 *
 *   1. close_round   (skipped if the round is already closed/finalized)
 *   2. score         (auto-score every unscored CompetitionEntry)
 *   3. reveal_top3   (queue the reveal, wait for the MPC callback)
 *   3b. distribute   (pay the SOL prize pool from the Treasury to the top 3 winners)
 *   4. finalize_round
 *   5. open_round    (open the next round)
 *
 * It reuses the EXACT instruction-calling patterns proven in scripts/operator.ts
 * (HTTP send/confirm on Helius, public-RPC fallback for getProgramAccounts, the
 * queue-accounts helper, and the Supabase result write) but does NOT depend on it.
 *
 * KEYPAIRS: Railway has no persistent secret filesystem, so both keys come from env vars as
 * Solana-CLI JSON array strings (e.g. "[12,34,...]"). Each is parsed, written to its OWN 0600
 * temp file under /tmp ONLY, used to load the Keypair, and unlinked on exit. Keys are never
 * logged. The OPERATOR key signs the program instructions (cycle); the separate TREASURY key
 * signs only the prize transfers. They are never mixed into the same variable or file.
 *
 * PRIZE POOL: after a successful reveal_top3 and BEFORE finalize, the Treasury pays
 * 5 / 3 / 2 SOL to the rank 1 / 2 / 3 winner wallets. Transfers are sequential and
 * independent — one failure is logged for manual retry and does NOT stop the rest of the
 * cycle (close/score/reveal/finalize/open still complete).
 *
 * ENV VARS:
 *   OPERATOR_PRIVATE_KEY  (required) JSON array string of the operator's 64-byte secret key
 *   TREASURY_PRIVATE_KEY  (required) JSON array string of the treasury's 64-byte secret key
 *   HELIUS_RPC_URL        (required) RPC for transactions + single-account reads
 *   ARCIUM_CLUSTER_OFFSET (default 456)
 *   SUPABASE_URL          (optional) round-history write (same pattern as operator.ts)
 *   SUPABASE_SERVICE_KEY  (optional)
 *
 * Run locally (NEVER commit the keys):
 *   export OPERATOR_PRIVATE_KEY='[...]'
 *   export TREASURY_PRIVATE_KEY='[...]'
 *   export HELIUS_RPC_URL='https://...'
 *   export ARCIUM_CLUSTER_OFFSET=456
 *   node scripts/auto-cycle.ts        # Node 22 strips TS types natively
 */
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import * as arcium from "@arcium-hq/client";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { SecretGarden } from "../target/types/secret_garden";

const { PublicKey, Keypair, Connection, LAMPORTS_PER_SOL } = anchor.web3;
type PK = anchor.web3.PublicKey;

// --- on-chain constants (programs/secret-garden/src/constants.rs) ---
const ROUND_STATUS_OPEN = 0;
const ROUND_STATUS_CLOSED = 1;
const ROUND_STATUS_FINALIZED = 2;
const ROUND_STATUS_NAME = ["OPEN", "CLOSED", "FINALIZED"];

// Minimum operator SOL balance required to attempt a cycle. Below this the script logs a
// top-up warning and exits WITHOUT running (a partial cycle from running out of fees mid-way
// is worse than skipping a day).
const MIN_BALANCE_SOL = 0.5;

// Prize pool: SOL paid from the Treasury to the rank 1/2/3 winners, in that order. Indexed
// by (rank - 1).
const PRIZE_SOL = [5, 3, 2];
// Minimum Treasury balance required before the cycle runs — at least one day's full prize
// pool (5 + 3 + 2 = 10 SOL). Transfer fees come from headroom above this, so in practice the
// treasury is kept well above 10; a per-payout shortfall is caught and logged for retry.
const MIN_TREASURY_SOL = 10.1;

// Each key is materialized here (under /tmp ONLY — never the project dir) and removed on
// exit. 0600 so only the process owner can read it. The operator key (cycle signer) and the
// treasury key (prize payer) are kept in SEPARATE files and SEPARATE variables.
const OPERATOR_KEYPAIR_PATH = path.join("/tmp", "operator-keypair.json");
const TREASURY_KEYPAIR_PATH = path.join("/tmp", "treasury-keypair.json");

// Remove BOTH temp keys on ANY exit — including the early process.exit() paths (low balance,
// fatal validation) that never reach main()'s catch. Synchronous, best-effort.
process.on("exit", () => {
  for (const p of [OPERATOR_KEYPAIR_PATH, TREASURY_KEYPAIR_PATH]) {
    try { fs.unlinkSync(p); } catch { /* never written, or already gone */ }
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const u64le = (n: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const short = (pk: PK | string) => {
  const s = typeof pk === "string" ? pk : pk.toBase58();
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
};
const fatal = (msg: string): never => {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
};

/**
 * Parse a Solana-CLI JSON-array secret key from `envVar`, write it to a 0600 temp file at
 * `tmpPath` (under /tmp ONLY), and load the Keypair FROM that file path. Exits immediately on
 * any problem. The key material itself is never logged. Used independently for the operator
 * key and the treasury key — each gets its own env var, temp file, and returned variable.
 */
function loadKeypairFromEnv(envVar: string, tmpPath: string): anchor.web3.Keypair {
  const raw = process.env[envVar];
  if (!raw || raw.trim() === "") {
    fatal(`${envVar} is not set. Provide the wallet's secret key as a JSON array string.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw!);
  } catch {
    fatal(`${envVar} is not valid JSON. Expected a JSON array like "[12,34,...]".`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    !parsed.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255)
  ) {
    fatal(`${envVar} must be a JSON array of 64 byte values (0-255) — the Solana CLI keypair format.`);
  }
  const secret = parsed as number[];

  // Write to /tmp (0600) and load the Keypair from that path, per the Railway secret model.
  fs.writeFileSync(tmpPath, JSON.stringify(secret), { mode: 0o600 });
  let kp: anchor.web3.Keypair;
  try {
    kp = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(tmpPath).toString())),
    );
  } catch {
    fatal(`Failed to construct a Keypair from ${envVar} (not a valid 64-byte secret key).`);
  }
  return kp!;
}

// Player-facing flower name for a winner (matches the frontend's species map).
const SPECIES_NAMES = [
  "Sunpetal Marigold", "Tideglass Bluebell", "Duskwisp Lavender",
  "Emberfern Rose", "Mossheart Mint", "Moonsilk Lily",
];
const flowerName = (visualSpeciesId: number, flowerIndex: number) =>
  visualSpeciesId === 255
    ? `Hybrid #${flowerIndex}`
    : (SPECIES_NAMES[visualSpeciesId] ?? `Flower #${flowerIndex}`);

interface WinnerRow {
  round_number: number;
  rank: number;
  wallet_address: string;
  flower_name: string;
  generation: number;
}

interface PrizeResult {
  rank: number;
  wallet: string;
  amountSol: number;
  ok: boolean;
  error?: string;
}

interface CycleSummary {
  closedRound: number | null;
  closedEntryCount: number | null;
  entriesScored: number;
  top3: string[];
  prizes: PrizeResult[];
  finalizedRound: number | null;
  openedRound: number | null;
}

async function main(): Promise<void> {
  // --- secrets + RPC wiring -------------------------------------------------
  // Load BOTH keys up-front (fail fast). Treasury must be ready BEFORE the cycle starts —
  // the cycle is effectively atomic, so we never want to close/score/reveal a round and only
  // THEN discover the treasury key is missing/invalid. Separate vars, separate temp files.
  const signer = loadKeypairFromEnv("OPERATOR_PRIVATE_KEY", OPERATOR_KEYPAIR_PATH);
  const treasury = loadKeypairFromEnv("TREASURY_PRIVATE_KEY", TREASURY_KEYPAIR_PATH);

  const heliusUrl = process.env.HELIUS_RPC_URL;
  if (!heliusUrl || heliusUrl.trim() === "") {
    fatal("HELIUS_RPC_URL is not set. It is required for transaction send/confirm.");
  }
  if (!process.env.ARCIUM_CLUSTER_OFFSET) process.env.ARCIUM_CLUSTER_OFFSET = "456";

  // Helius for transactions + single-account reads; public devnet RPC for getProgramAccounts
  // (Helius free tier blocks it) — the exact split proven in scripts/operator.ts.
  const conn = new Connection(heliusUrl!, "confirmed");
  const publicConn = new Connection("https://api.devnet.solana.com", "confirmed");

  const wallet = new anchor.Wallet(signer);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(new URL("../target/idl/secret_garden.json", import.meta.url)).toString(),
  );
  const program = new anchor.Program<SecretGarden>(idl as SecretGarden, provider);

  const arciumEnv = arcium.getArciumEnv();
  const clusterAccount = arcium.getClusterAccAddress(arciumEnv.arciumClusterOffset);
  const mxeAccount = arcium.getMXEAccAddress(program.programId);

  const configPda = PublicKey.findProgramAddressSync(
    [Buffer.from("config")], program.programId)[0];
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
  // `payer` is the fee-payer + sole signer for the tx; defaults to the operator `signer` for
  // program instructions, but prize transfers pass the `treasury` keypair instead.
  async function sendTxHttp(
    tx: anchor.web3.Transaction,
    label: string,
    payer: anchor.web3.Keypair = signer,
  ): Promise<string> {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const bh = await conn.getLatestBlockhash({ commitment: "confirmed" });
      tx.recentBlockhash = bh.blockhash;
      tx.lastValidBlockHeight = bh.lastValidBlockHeight;
      tx.feePayer = payer.publicKey;
      tx.signatures = [];
      tx.sign(payer);
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

  // Enumerate every CompetitionEntry of a round via the public RPC (Helius free tier blocks
  // getProgramAccounts). The first field `round: pubkey` sits at offset 8 (after the
  // 8-byte discriminator). Decoded with the program's own coder.
  async function entriesForRound(round: PK): Promise<any[]> {
    const accounts = await publicConn.getProgramAccounts(program.programId, {
      filters: [{ memcmp: { offset: 8, bytes: round.toBase58() } }],
    });
    return accounts.map((a) => ({
      pubkey: a.pubkey as PK,
      ...(program.coder.accounts.decode("competitionEntry", a.account.data) as any),
    }));
  }

  // Persist a finished round's results to Supabase (same pattern as operator.ts). Skipped
  // silently when SUPABASE_URL/SERVICE_KEY aren't set; never fatal to the cycle.
  async function saveResultsToSupabase(roundNumber: number, round: any, scored: any[]) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) return;

    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(url, key);
    const targetTraits: number[] = (round.targetTraits as number[]).slice(0, round.targetTraitCount);

    const resultsErr = (
      await supabase.from("round_results").insert({
        round_number: roundNumber,
        target_traits: JSON.stringify(targetTraits),
        total_entrants: round.participantCount,
        completed_at: new Date().toISOString(),
      })
    ).error;

    const byEntry = new Map<string, any>(scored.map((e) => [(e.pubkey as PK).toBase58(), e]));
    const top: PK[] = [round.top1, round.top2, round.top3];
    const winnerRows: WinnerRow[] = [];
    for (let i = 0; i < top.length; i++) {
      const entry = byEntry.get(top[i].toBase58());
      if (!entry) continue;
      const flower: any = await program.account.flowerRecord.fetch(entry.flowerRecord);
      winnerRows.push({
        round_number: roundNumber,
        rank: i + 1,
        wallet_address: (entry.player as PK).toBase58(),
        flower_name: flowerName(flower.visualSpeciesId, flower.flowerIndex),
        generation: flower.generation,
      });
    }
    const winnersErr = winnerRows.length
      ? (await supabase.from("round_winners").insert(winnerRows)).error
      : null;

    if (resultsErr || winnersErr) {
      console.log(`  (Supabase write error: ${(resultsErr ?? winnersErr)!.message})`);
      return;
    }
    console.log(`  Results saved to Supabase`);
  }

  // Pay the SOL prize pool from the Treasury to each winner wallet, sequentially (rank 1, then
  // 2, then 3). Each transfer is independent: a failure is logged and recorded but does NOT
  // abort the others or the surrounding cycle — a failed payout is surfaced for MANUAL retry.
  async function distributePrizes(
    winners: { rank: number; wallet: PK }[],
  ): Promise<PrizeResult[]> {
    const results: PrizeResult[] = [];
    for (const w of winners) {
      const sol = PRIZE_SOL[w.rank - 1];
      const lamports = Math.round(sol * LAMPORTS_PER_SOL);
      try {
        const tx = new anchor.web3.Transaction().add(
          anchor.web3.SystemProgram.transfer({
            fromPubkey: treasury.publicKey,
            toPubkey: w.wallet,
            lamports,
          }),
        );
        // Treasury is the fee-payer + source, so it (not the operator) signs this tx.
        const sig = await sendTxHttp(tx, `prize rank ${w.rank} (${sol} SOL)`, treasury);
        console.log(`  ✓ rank ${w.rank}: sent ${sol} SOL to ${w.wallet.toBase58()} (sig ${short(sig)})`);
        results.push({ rank: w.rank, wallet: w.wallet.toBase58(), amountSol: sol, ok: true });
      } catch (e) {
        const msg = (e as Error).message;
        console.error(`  ✗ rank ${w.rank}: FAILED to send ${sol} SOL to ${w.wallet.toBase58()} — ${msg}`);
        console.error(`    (cycle continues; retry this payout manually)`);
        results.push({ rank: w.rank, wallet: w.wallet.toBase58(), amountSol: sol, ok: false, error: msg });
      }
    }
    return results;
  }

  // --- balance gates (operator fees + treasury prize pool) ------------------
  // Both checked BEFORE any cycle work so a low balance skips the day cleanly rather than
  // closing a round and then stalling.
  console.log(`\n=== Secret Garden — AUTO-CYCLE (cluster ${arciumEnv.arciumClusterOffset}) ===`);
  console.log(`  operator wallet : ${signer.publicKey.toBase58()}`);
  console.log(`  treasury wallet : ${treasury.publicKey.toBase58()}`);

  const startLamports = await conn.getBalance(signer.publicKey, "confirmed");
  const startSol = startLamports / LAMPORTS_PER_SOL;
  if (startSol < MIN_BALANCE_SOL) {
    console.error(
      `\nACTION REQUIRED — LOW BALANCE: operator wallet ${signer.publicKey.toBase58()} ` +
      `holds ${startSol.toFixed(4)} SOL, below the ${MIN_BALANCE_SOL} SOL minimum.`);
    console.error(`Top up this wallet, then the next scheduled run will proceed. Skipping the cycle.`);
    process.exit(1);
  }
  console.log(`  operator balance: ${startSol.toFixed(4)} SOL (>= ${MIN_BALANCE_SOL} minimum) — proceeding`);

  const treasuryStartSol = (await conn.getBalance(treasury.publicKey, "confirmed")) / LAMPORTS_PER_SOL;
  if (treasuryStartSol < MIN_TREASURY_SOL) {
    console.error(
      `\nACTION REQUIRED — LOW TREASURY BALANCE: treasury wallet ${treasury.publicKey.toBase58()} ` +
      `holds ${treasuryStartSol.toFixed(4)} SOL, below the ${MIN_TREASURY_SOL} SOL minimum ` +
      `(one day's prize pool is ${PRIZE_SOL.reduce((a, b) => a + b, 0)} SOL).`);
    console.error(`Top up the treasury, then the next scheduled run will proceed. Skipping the cycle.`);
    process.exit(1);
  }
  console.log(`  treasury balance: ${treasuryStartSol.toFixed(4)} SOL (>= ${MIN_TREASURY_SOL} minimum) — proceeding`);

  // --- authorization: wallet must be the config authority or a registered operator ------
  const cfg: any = await program.account.gameConfig.fetch(configPda);
  const isAuthority = cfg.authority.equals(signer.publicKey);
  const operators: PK[] = (cfg.operators as PK[]).slice(0, cfg.operatorCount);
  const isOperator = operators.some((op) => op.equals(signer.publicKey));
  if (!isAuthority && !isOperator) {
    fatal(
      `wallet ${short(signer.publicKey)} is neither the config authority (${short(cfg.authority)}) ` +
      `nor a registered operator — it cannot run the cycle.`);
  }
  console.log(`  authorized as   : ${isAuthority ? "AUTHORITY" : "OPERATOR"}`);

  const current = cfg.currentRound.toNumber();
  const summary: CycleSummary = {
    closedRound: null, closedEntryCount: null, entriesScored: 0,
    top3: [], prizes: [], finalizedRound: null, openedRound: null,
  };

  // First-ever run (no round opened yet): there is nothing to close/score/reveal/finalize —
  // just open round 1.
  if (current === 0) {
    console.log(`\n[open] no round has ever been opened — opening round 1`);
    await openNextRound(0);
    summary.openedRound = 1;
    printSummary(summary, await balanceSol(), await treasuryBalanceSol());
    return;
  }

  const round = roundPda(current);

  // ---------------------------------------------------------------- 1. CLOSE
  let r: any = await program.account.competitionRound.fetch(round);
  console.log(`\n[close] round ${current} is ${ROUND_STATUS_NAME[r.status]}, ${r.participantCount} entries`);
  if (r.status === ROUND_STATUS_OPEN) {
    const tx = await program.methods.closeRound()
      .accountsPartial({ authority: signer.publicKey, config: configPda, round }).transaction();
    await sendTxHttp(tx, `closeRound(${current})`);
    r = await program.account.competitionRound.fetch(round);
    console.log(`  ✓ round ${current} closed (${r.participantCount} entries)`);
  } else {
    console.log(`  ↪ skipping close — round already ${ROUND_STATUS_NAME[r.status]}`);
  }
  summary.closedRound = current;
  summary.closedEntryCount = r.participantCount;

  const hasEntries = r.participantCount > 0;

  // ---------------------------------------------------------------- 2. SCORE
  if (r.status === ROUND_STATUS_FINALIZED) {
    console.log(`\n[score] skipping — round ${current} already FINALIZED`);
  } else if (!hasEntries) {
    console.log(`\n[score] skipping — round ${current} has 0 entries`);
  } else {
    const entries = await entriesForRound(round);
    const unscored = entries.filter((e) => !e.scored);
    console.log(`\n[score] round ${current}: ${entries.length} entries, ${unscored.length} unscored`);
    for (let i = 0; i < unscored.length; i++) {
      const e = unscored[i];
      const entry = entryPda(round, e.player as PK);
      console.log(`  scoring ${i + 1}/${unscored.length} (wallet ${short(e.player as PK)})`);
      const offset = freshOffset();
      const tx = await program.methods.queueScoreEntry(offset)
        .accountsPartial({
          authority: signer.publicKey,
          round,
          entry,
          flowerRecord: e.flowerRecord as PK,
          ...queueAccsFor("score_entry", offset),
        }).transaction();
      await sendTxHttp(tx, `queueScoreEntry[${i + 1}]`);
      await arcium.awaitComputationFinalization(
        provider, offset, program.programId, "confirmed", 360000);

      let scored = false;
      for (let k = 0; k < 120; k++) {
        if ((await program.account.competitionEntry.fetch(entry)).scored) { scored = true; break; }
        await sleep(1000);
      }
      if (!scored) throw new Error(`entry ${short(e.player as PK)} did not reach scored=true after MPC`);
      console.log(`    ✓ scored`);
    }
    const after: any = await program.account.competitionRound.fetch(round);
    summary.entriesScored = after.scoredCount;
    console.log(`  ✓ all entries scored (scoredCount=${after.scoredCount})`);
  }

  // --------------------------------------------------------------- 3. REVEAL
  r = await program.account.competitionRound.fetch(round);
  if (r.status === ROUND_STATUS_FINALIZED) {
    console.log(`\n[reveal] skipping — round ${current} already FINALIZED`);
    summary.top3 = [r.top1, r.top2, r.top3].map((p: PK) => p.toBase58());
  } else if (r.scoringRevealed) {
    // Resumed run: reveal already happened previously, so prizes were (or should have been)
    // paid by that run. We do NOT auto-distribute again — there is no on-chain payout ledger,
    // so re-paying here would double-pay. Surface it for manual verification instead.
    console.log(`\n[reveal] already revealed in a prior run — reusing stored winners`);
    console.log(`  ⚠ NOT auto-distributing prizes (double-pay guard). If the prior run's payouts`);
    console.log(`    did not complete, verify on-chain and pay the affected winner(s) manually.`);
    summary.top3 = [r.top1, r.top2, r.top3].map((p: PK) => p.toBase58());
  } else if (!hasEntries) {
    console.log(`\n[reveal] skipping — round ${current} has 0 entries (nothing to rank)`);
  } else {
    if (r.scoredCount !== r.participantCount) {
      throw new Error(`scoring incomplete: ${r.scoredCount}/${r.participantCount} scored`);
    }
    const entries = await entriesForRound(round);
    const scored = entries.filter((e) => e.scored);
    if (scored.length !== r.participantCount) {
      throw new Error(`found ${scored.length} scored entries but participantCount=${r.participantCount}`);
    }
    const remaining = scored.map((e) => ({
      pubkey: e.pubkey as PK, isWritable: false, isSigner: false,
    }));
    const offset = freshOffset();
    const tx = await program.methods.queueRevealTop3(offset)
      .accountsPartial({ authority: signer.publicKey, round, ...queueAccsFor("reveal_top3", offset) })
      .remainingAccounts(remaining)
      .transaction();
    await sendTxHttp(tx, "queueRevealTop3");
    console.log(`\n[reveal] queued; awaiting MPC finalization...`);
    await arcium.awaitComputationFinalization(
      provider, offset, program.programId, "confirmed", 360000);

    let revealed = false;
    let rr: any;
    for (let k = 0; k < 180; k++) {
      rr = await program.account.competitionRound.fetch(round);
      if (rr.scoringRevealed) { revealed = true; break; }
      await sleep(1000);
    }
    if (!revealed) throw new Error("reveal MPC finalized but round.scoringRevealed never flipped");

    const byEntry = new Map(scored.map((e) => [(e.pubkey as PK).toBase58(), e.player as PK]));
    const winner = (entry: PK) => {
      const p = byEntry.get(entry.toBase58());
      return p ? p.toBase58() : `(entry ${entry.toBase58()})`;
    };
    summary.top3 = [winner(rr.top1), winner(rr.top2), winner(rr.top3)];
    console.log(`  ✓ winners revealed:`);
    console.log(`    1st: ${summary.top3[0]}`);
    console.log(`    2nd: ${summary.top3[1]}`);
    console.log(`    3rd: ${summary.top3[2]}`);
    await saveResultsToSupabase(current, rr, scored);

    // --- PRIZE DISTRIBUTION (after a successful reveal, before finalize) ---
    // Resolve each filled rank to its PLAYER WALLET (round.topN holds the winning ENTRY
    // pubkey; the prize goes to the player, not the entry account). Ranks beyond
    // participant_count are Pubkey::default and skipped.
    const winnerWallets: { rank: number; wallet: PK }[] = [];
    [rr.top1, rr.top2, rr.top3].forEach((entryPk: PK, idx: number) => {
      if (entryPk.equals(PublicKey.default)) return; // unfilled rank (< idx+1 participants)
      const player = byEntry.get(entryPk.toBase58());
      if (player) winnerWallets.push({ rank: idx + 1, wallet: player });
    });
    console.log(`\n[distribute] paying prize pool from treasury to ${winnerWallets.length} winner(s)...`);
    summary.prizes = await distributePrizes(winnerWallets);
  }

  // ------------------------------------------------------------- 4. FINALIZE
  r = await program.account.competitionRound.fetch(round);
  if (r.status === ROUND_STATUS_FINALIZED) {
    console.log(`\n[finalize] skipping — round ${current} already FINALIZED`);
  } else {
    const tx = await program.methods.finalizeRound()
      .accountsPartial({ authority: signer.publicKey, config: configPda, round }).transaction();
    await sendTxHttp(tx, `finalizeRound(${current})`);
    console.log(`\n[finalize] ✓ round ${current} finalized`);
  }
  summary.finalizedRound = current;

  // ----------------------------------------------------------------- 5. OPEN
  console.log(`\n[open] opening round ${current + 1}`);
  await openNextRound(current);
  summary.openedRound = current + 1;

  // Log treasury balance after distribution (per spec) and include it in the summary.
  const treasuryEndSol = await treasuryBalanceSol();
  console.log(`\n[treasury] balance after distribution: ${treasuryEndSol.toFixed(4)} SOL`);
  printSummary(summary, await balanceSol(), treasuryEndSol);

  // --- local helpers that close over the wired-up program/provider ----------
  async function openNextRound(currentRound: number): Promise<void> {
    const tx = await program.methods.openRound()
      .accountsPartial({
        authority: signer.publicKey,
        config: configPda,
        previousRound: currentRound > 0 ? roundPda(currentRound) : null,
        round: roundPda(currentRound + 1),
      }).transaction();
    await sendTxHttp(tx, `openRound(${currentRound + 1})`);
    const opened: any = await program.account.competitionRound.fetch(roundPda(currentRound + 1));
    console.log(`  ✓ round ${currentRound + 1} opened — target traits `
      + `[${Array.from(opened.targetTraits).slice(0, opened.targetTraitCount)}] `
      + `(count ${opened.targetTraitCount})`);
  }

  async function balanceSol(): Promise<number> {
    return (await conn.getBalance(signer.publicKey, "confirmed")) / LAMPORTS_PER_SOL;
  }

  async function treasuryBalanceSol(): Promise<number> {
    return (await conn.getBalance(treasury.publicKey, "confirmed")) / LAMPORTS_PER_SOL;
  }
}

function printSummary(s: CycleSummary, operatorSol: number, treasurySol: number): void {
  const line = "─".repeat(48);
  console.log(`\n${line}`);
  console.log(`AUTO-CYCLE COMPLETE`);
  console.log(line);
  console.log(`  Round closed       : ${s.closedRound ?? "—"}`
    + (s.closedEntryCount === null ? "" : ` (${s.closedEntryCount} entries)`));
  console.log(`  Entries scored     : ${s.entriesScored}`);
  console.log(`  Top 3 revealed     : ${s.top3.length ? "" : "—"}`);
  s.top3.forEach((w, i) => console.log(`    ${i + 1}. ${w}`));
  console.log(`  Prize distribution : ${s.prizes.length ? "" : "— (no payouts this run)"}`);
  s.prizes.forEach((p) =>
    console.log(`    rank ${p.rank}: ${p.amountSol} SOL -> ${p.wallet}  [${p.ok ? "SENT" : "FAILED"}]`
      + (p.ok || !p.error ? "" : ` (${p.error})`)));
  const failed = s.prizes.filter((p) => !p.ok);
  if (failed.length) {
    console.log(`    ⚠ ${failed.length} payout(s) FAILED — retry manually: `
      + failed.map((p) => `rank ${p.rank} (${p.amountSol} SOL -> ${p.wallet})`).join(", "));
  }
  console.log(`  Round finalized    : ${s.finalizedRound ?? "—"}`);
  console.log(`  New round opened   : ${s.openedRound ?? "—"}`);
  console.log(`  Operator balance   : ${operatorSol.toFixed(4)} SOL`);
  console.log(`  Treasury balance   : ${treasurySol.toFixed(4)} SOL`);
  console.log(line);
}

main()
  .then(() => process.exit(0)) // temp key removed by the process 'exit' handler
  .catch((e) => {
    console.error(`\nAUTO-CYCLE FAILED: ${(e as Error).message}`);
    process.exit(1);
  });
