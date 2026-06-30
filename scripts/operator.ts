/**
 * Secret Garden — DEVNET operator tool (cluster 456).
 *
 * A permanent, daily-use CLI for running competition rounds against the LIVE
 * deployment, driven by the COMMAND env var. It uses the operator's local
 * keypair directly (NO browser wallet popup) and the reliable Helius RPC with
 * HTTP send/confirm + HTTP polling — the exact proven patterns from
 * tests/breeding.devnet.ts and tests/scoring.devnet.ts. No new patterns.
 *
 * COMMANDS (set via COMMAND=...):
 *   status  — print GameConfig + current round info (no transaction)
 *   open    — open_round; print round number + randomly-assigned target traits
 *   close   — close_round; print "Round N closed. X entries received."
 *   score   — auto-score every unscored CompetitionEntry of the current round
 *             (queue_score_entry per entry, no wallet popup)
 *   reveal  — queue_reveal_top3; wait for MPC; print the top-3 winner wallets
 *   finalize— finalize_round; required terminal step before the next open_round
 *
 *   Round-running commands (open/close/score/reveal/finalize) accept the config
 *   AUTHORITY or any registered OPERATOR. Operator administration is authority-only:
 *   migrate-config — one-time: grow GameConfig to the multi-operator layout (run once
 *                    immediately after the redeploy that added operators)
 *   add-operator    OPERATOR=<pubkey> — register an operator wallet (max 3)
 *   remove-operator OPERATOR=<pubkey> — unregister an operator wallet
 *   list-operators  — print the authority + the registered operators
 *
 * Run (always `source .env` first so HELIUS_RPC_URL is set):
 *   source .env && ANCHOR_PROVIDER_URL=$HELIUS_RPC_URL \
 *     ANCHOR_WALLET=$HOME/.config/solana/id.json \
 *     ARCIUM_CLUSTER_OFFSET=456 \
 *     COMMAND=status \
 *     npx mocha --no-config --timeout 300000 scripts/operator.ts
 */
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import * as arcium from "@arcium-hq/client";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import type { SecretGarden } from "../target/types/secret_garden";

const { PublicKey, Keypair } = anchor.web3;
type PK = anchor.web3.PublicKey;
type KP = anchor.web3.Keypair;

// --- on-chain constants (programs/secret-garden/src/constants.rs) ---
const ROUND_STATUS_OPEN = 0;
const ROUND_STATUS_CLOSED = 1;
const ROUND_STATUS_FINALIZED = 2;
const ROUND_STATUS_NAME = ["OPEN", "CLOSED", "FINALIZED"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const u64le = (n: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
function readKpJson(p: string): KP {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p).toString())));
}
const short = (pk: PK | string) => {
  const s = typeof pk === "string" ? pk : pk.toBase58();
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
};

const COMMAND = (process.env.COMMAND || "status").trim().toLowerCase();

describe(`secret-garden operator [COMMAND=${COMMAND}] (cluster 456)`, () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const conn = provider.connection;
  // Public RPC fallback — Helius Free tier blocks getProgramAccounts (used by
  // program.account.X.all()). Transactions still go through Helius via `conn`.
  const publicConn = new anchor.web3.Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );
  const program = anchor.workspace.SecretGarden as anchor.Program<SecretGarden>;
  const authority = readKpJson(`${os.homedir()}/.config/solana/id.json`);

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

  // Enumerate every CompetitionEntry of a round (first field `round: pubkey`
  // sits at offset 8, right after the 8-byte account discriminator).
  async function entriesForRound(round: PK): Promise<any[]> {
    const accounts = await publicConn.getProgramAccounts(program.programId, {
      filters: [{ memcmp: { offset: 8, bytes: round.toBase58() } }],
    });
    return accounts.map((a) => ({
      pubkey: a.pubkey as PK,
      ...(program.coder.accounts.decode("competitionEntry", a.account.data) as any),
    }));
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

  // Persist a finished round's results to Supabase so the frontend Daily Winners panel can show
  // them. Server-side write with the SERVICE key (bypasses RLS). Skipped silently when
  // SUPABASE_URL/SERVICE_KEY aren't configured, and never fatal to the reveal itself.
  async function saveResultsToSupabase(roundNumber: number, round: any, scored: any[]) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) return; // not configured — skip silently

    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(url, key);

    const targetTraits: number[] = (round.targetTraits as number[]).slice(0, round.targetTraitCount);

    // round_results — one summary row for the round.
    const resultsErr = (
      await supabase.from("round_results").insert({
        round_number: roundNumber,
        target_traits: JSON.stringify(targetTraits),
        total_entrants: round.participantCount,
        completed_at: new Date().toISOString(),
      })
    ).error;

    // round_winners — one row per top-3 winner, with the flower's player-facing name + gen.
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
    console.log(`Results saved to Supabase`);
  }

  // Commands that ONLY the config authority may run (operators are barred).
  const AUTHORITY_ONLY = new Set(["migrate-config", "add-operator", "remove-operator"]);

  it(`run COMMAND=${COMMAND}`, async function () {
    this.timeout(900_000);

    // ---------------------------------------------------------- MIGRATE-CONFIG
    // Must run BEFORE the typed gameConfig.fetch: a pre-operator config is shorter
    // than the current layout and the typed decoder cannot deserialize it. Read the
    // account raw and parse the stored authority from bytes [8..40] for a local guard.
    if (COMMAND === "migrate-config") {
      const info = await conn.getAccountInfo(configPda, "confirmed");
      if (!info) throw new Error("config account not found");
      const storedAuthority = new PublicKey(info.data.subarray(8, 40));
      if (!storedAuthority.equals(authority.publicKey)) {
        throw new Error(
          `migrate-config requires the AUTHORITY (${short(storedAuthority)}), not ${short(authority.publicKey)}`);
      }
      const tx = await program.methods.migrateConfig()
        .accountsPartial({ authority: authority.publicKey, config: configPda })
        .transaction();
      await sendTxHttp(tx, "migrateConfig");
      const cfgAfter: any = await program.account.gameConfig.fetch(configPda);
      console.log(`\nConfig migrated. operatorCount=${cfgAfter.operatorCount}`);
      return;
    }

    const cfg: any = await program.account.gameConfig.fetch(configPda);
    const isAuthority = cfg.authority.equals(authority.publicKey);
    const operators: PK[] = (cfg.operators as PK[]).slice(0, cfg.operatorCount);
    const isOperator = operators.some((op) => op.equals(authority.publicKey));

    // Authorization gate. Admin commands are authority-only; round-running commands
    // (open/close/score/reveal/finalize) accept the authority OR any registered operator.
    if (AUTHORITY_ONLY.has(COMMAND)) {
      if (!isAuthority) {
        throw new Error(
          `COMMAND=${COMMAND} requires the config AUTHORITY (${short(cfg.authority)}), not ${short(authority.publicKey)}`);
      }
    } else if (!isAuthority && !isOperator) {
      throw new Error(
        `keypair (${short(authority.publicKey)}) is neither the authority nor a registered operator`);
    }
    const current = cfg.currentRound.toNumber();

    // ----------------------------------------------------------------- STATUS
    if (COMMAND === "status") {
      console.log(`\n=== Secret Garden — STATUS ===`);
      console.log(`  operator   : ${authority.publicKey.toBase58()}`);
      console.log(`  paused     : ${cfg.paused}`);
      console.log(`  currentRound: ${current}`);
      if (current === 0) {
        console.log(`  (no round opened yet — run COMMAND=open)`);
        return;
      }
      const round: any = await program.account.competitionRound.fetch(roundPda(current));
      const statusName = ROUND_STATUS_NAME[round.status] ?? `?(${round.status})`;
      console.log(`\n  Round #${round.roundId.toString()}`);
      console.log(`    status        : ${statusName}`);
      console.log(`    entries       : ${round.participantCount} / max ${round.maxParticipants}`);
      console.log(`    scored        : ${round.scoredCount} / ${round.participantCount}`);
      console.log(`    targetTraits  : [${Array.from(round.targetTraits).slice(0, round.targetTraitCount)}]`
        + ` (count ${round.targetTraitCount})`);
      console.log(`    top3 revealed : ${round.scoringRevealed}`);
      if (round.scoringRevealed) {
        console.log(`      1st: ${round.top1.toBase58()}`);
        console.log(`      2nd: ${round.top2.toBase58()}`);
        console.log(`      3rd: ${round.top3.toBase58()}`);
      }
      return;
    }

    // ------------------------------------------------------------------- OPEN
    if (COMMAND === "open") {
      const tx = await program.methods.openRound()
        .accountsPartial({
          authority: authority.publicKey,
          config: configPda,
          previousRound: current > 0 ? roundPda(current) : null,
          round: roundPda(current + 1),
        }).transaction();
      await sendTxHttp(tx, `openRound(${current + 1})`);
      const round: any = await program.account.competitionRound.fetch(roundPda(current + 1));
      console.log(`\nRound ${current + 1} opened successfully`);
      console.log(`  target traits: [${Array.from(round.targetTraits).slice(0, round.targetTraitCount)}]`
        + ` (count ${round.targetTraitCount})`);
      return;
    }

    // ------------------------------------------------------------------ CLOSE
    if (COMMAND === "close") {
      if (current === 0) throw new Error("no round to close");
      const round = roundPda(current);
      const tx = await program.methods.closeRound()
        .accountsPartial({ authority: authority.publicKey, config: configPda, round }).transaction();
      await sendTxHttp(tx, `closeRound(${current})`);
      const r: any = await program.account.competitionRound.fetch(round);
      console.log(`\nRound ${current} closed. ${r.participantCount} entries received.`);
      return;
    }

    // ------------------------------------------------------------------ SCORE
    if (COMMAND === "score") {
      if (current === 0) throw new Error("no round to score");
      const round = roundPda(current);
      const r: any = await program.account.competitionRound.fetch(round);
      if (r.status !== ROUND_STATUS_CLOSED) {
        throw new Error(`round ${current} must be CLOSED to score (status=${ROUND_STATUS_NAME[r.status]})`);
      }
      const entries = await entriesForRound(round);
      const unscored = entries.filter((e) => !e.scored);
      console.log(`\nRound ${current}: ${entries.length} entries, ${unscored.length} unscored.`);
      if (unscored.length === 0) {
        console.log(`All entries already scored. Nothing to do.`);
        return;
      }

      let done = 0;
      for (let i = 0; i < unscored.length; i++) {
        const e = unscored[i];
        const entry = entryPda(round, e.player as PK);
        console.log(`Scoring entry ${i + 1} of ${unscored.length} (wallet: ${short(e.player as PK)})`);
        const offset = freshOffset();
        const tx = await program.methods.queueScoreEntry(offset)
          .accountsPartial({
            authority: authority.publicKey,
            round,
            entry,
            flowerRecord: e.flowerRecord as PK,
            ...queueAccsFor("score_entry", offset),
          }).transaction();
        await sendTxHttp(tx, `queueScoreEntry[${i + 1}]`);
        await arcium.awaitComputationFinalization(
          provider, offset, program.programId, "confirmed", 360000);

        // Confirm the callback persisted `scored` before moving on.
        let scored = false;
        for (let k = 0; k < 120; k++) {
          if ((await program.account.competitionEntry.fetch(entry)).scored) { scored = true; break; }
          await sleep(1000);
        }
        if (!scored) throw new Error(`entry ${short(e.player as PK)} did not reach scored=true after MPC`);
        done++;
        console.log(`  ✓ entry ${i + 1} scored`);
      }
      const after: any = await program.account.competitionRound.fetch(round);
      console.log(`\nAll ${done} entries scored successfully (round.scoredCount=${after.scoredCount}).`);
      return;
    }

    // ----------------------------------------------------------------- REVEAL
    if (COMMAND === "reveal") {
      if (current === 0) throw new Error("no round to reveal");
      const round = roundPda(current);
      const r: any = await program.account.competitionRound.fetch(round);
      if (r.scoringRevealed) {
        console.log(`\nRound ${current} already revealed.`);
        console.log(`  1st: ${r.top1.toBase58()}`);
        console.log(`  2nd: ${r.top2.toBase58()}`);
        console.log(`  3rd: ${r.top3.toBase58()}`);
        return;
      }
      if (r.scoredCount !== r.participantCount) {
        throw new Error(`scoring incomplete: ${r.scoredCount}/${r.participantCount} scored (run COMMAND=score)`);
      }

      // The circuit reads each entry's stored score by reference; the entries
      // must be passed as remaining_accounts in slot order (exactly
      // participant_count of them).
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
        .accountsPartial({ authority: authority.publicKey, round, ...queueAccsFor("reveal_top3", offset) })
        .remainingAccounts(remaining)
        .transaction();
      await sendTxHttp(tx, "queueRevealTop3");
      console.log(`\n[reveal_top3] queued; awaiting MPC finalization...`);
      await arcium.awaitComputationFinalization(
        provider, offset, program.programId, "confirmed", 360000);

      // Poll the round until the callback flips scoringRevealed and writes top1..3.
      let revealed = false;
      let rr: any;
      for (let k = 0; k < 180; k++) {
        rr = await program.account.competitionRound.fetch(round);
        if (rr.scoringRevealed) { revealed = true; break; }
        await sleep(1000);
      }
      if (!revealed) throw new Error("reveal MPC finalized but round.scoringRevealed never flipped");

      // Map winning entry pubkeys back to the player wallet that submitted them.
      const byEntry = new Map(scored.map((e) => [(e.pubkey as PK).toBase58(), e.player as PK]));
      const winner = (entry: PK) => {
        const p = byEntry.get(entry.toBase58());
        return p ? p.toBase58() : `(entry ${entry.toBase58()})`;
      };
      console.log(`\nWinners revealed! Top 3:`);
      console.log(`  1st: ${winner(rr.top1)}`);
      console.log(`  2nd: ${winner(rr.top2)}`);
      console.log(`  3rd: ${winner(rr.top3)}`);

      // Persist to Supabase for the frontend Daily Winners panel (skipped if not configured).
      await saveResultsToSupabase(current, rr, scored);
      return;
    }

    // ---------------------------------------------------------------- FINALIZE
    if (COMMAND === "finalize") {
      if (current === 0) throw new Error("no round to finalize");
      const round = roundPda(current);
      const r: any = await program.account.competitionRound.fetch(round);
      if (r.status === ROUND_STATUS_FINALIZED) {
        console.log(`\nRound ${current} already FINALIZED.`);
        return;
      }
      const tx = await program.methods.finalizeRound()
        .accountsPartial({ authority: authority.publicKey, config: configPda, round }).transaction();
      await sendTxHttp(tx, `finalizeRound(${current})`);
      console.log(`\nRound ${current} finalized. Ready to open the next round.`);
      return;
    }

    // ------------------------------------------------------------ LIST-OPERATORS
    if (COMMAND === "list-operators") {
      console.log(`\n=== Operators ===`);
      console.log(`Authority : ${cfg.authority.toBase58()}`);
      if (operators.length === 0) {
        console.log(`(no operators registered)`);
      } else {
        operators.forEach((op, i) => console.log(`Operator ${i + 1}: ${op.toBase58()}`));
      }
      return;
    }

    // -------------------------------------------------------------- ADD-OPERATOR
    if (COMMAND === "add-operator") {
      const opStr = process.env.OPERATOR;
      if (!opStr) throw new Error("set OPERATOR=<pubkey> to add an operator");
      const newOp = new PublicKey(opStr.trim());
      const tx = await program.methods.addOperator(newOp)
        .accountsPartial({ authority: authority.publicKey, config: configPda }).transaction();
      await sendTxHttp(tx, "addOperator");
      console.log(`\nOperator added: ${newOp.toBase58()}`);
      return;
    }

    // ----------------------------------------------------------- REMOVE-OPERATOR
    if (COMMAND === "remove-operator") {
      const opStr = process.env.OPERATOR;
      if (!opStr) throw new Error("set OPERATOR=<pubkey> to remove an operator");
      const op = new PublicKey(opStr.trim());
      const tx = await program.methods.removeOperator(op)
        .accountsPartial({ authority: authority.publicKey, config: configPda }).transaction();
      await sendTxHttp(tx, "removeOperator");
      console.log(`\nOperator removed: ${op.toBase58()}`);
      return;
    }

    throw new Error(`unknown COMMAND="${COMMAND}" (use status|open|close|score|reveal|finalize`
      + `|migrate-config|add-operator|remove-operator|list-operators)`);
  });
});
