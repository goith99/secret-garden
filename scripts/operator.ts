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
 * Run — use `set -a` so .env is EXPORTED, not just set as shell variables. A plain
 * `source .env` leaves SUPABASE_URL/SUPABASE_SERVICE_KEY invisible to this process, and
 * saveResultsToSupabase() then skips SILENTLY: the reveal succeeds on-chain but the
 * frontend's Daily Winners panel never learns about the round. (This is the same idiom the
 * devnet tests already use.)
 *   set -a; source .env; set +a
 *   ANCHOR_PROVIDER_URL=$HELIUS_RPC_URL \
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

const { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } = anchor.web3;

/** SOL paid per rank, mirroring auto-cycle's PRIZE_SOL. Kept in step with it by hand — the two
 *  tools pay the same pool and a divergence here would silently over- or under-pay. */
/**
 * First round whose SOL prizes are recorded by an on-chain `PrizeDistribution` marker.
 *
 * Anything BELOW this predates the ledger: those rounds were paid (or not) by bare treasury
 * transfers that recorded nothing, so the absence of a marker tells you nothing about them.
 * The `distribute` command refuses them without an explicit BACKFILL=1. Raise this if the
 * upgrade slips to a later round; never lower it.
 *
 * 73, not 72: Railway only picked up the marker-writing code after the push at ~11:15Z on
 * 2026-08-31, by which time the 10:01Z cycle had already paid round 72 the old way. Confirmed
 * against the treasury's parsed transfers — 70, 71 and 72 all show 0.5 SOL to every winner.
 */
const PRIZE_MARKER_FIRST_ROUND = 73;

const PRIZE_SOL = [0.5, 0.5, 0.5];
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

// --- $SGD pot vault -------------------------------------------------------------------------
// open_round now creates the round's pot vault itself, funded by the operator, so the round's
// first entrant is not billed rent nobody else pays. `sgd_mint` is the one account Anchor
// cannot derive (it has neither seeds nor a fixed address in the IDL), so it must be passed
// explicitly — accountsPartial alone would fail at runtime.
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const potAuthorityPda = (roundId: number): PK =>
  PublicKey.findProgramAddressSync([Buffer.from("pot"), u64le(roundId)], program.programId)[0];
const ataFor = (owner: PK, mint: PK): PK =>
  PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
/** The five accounts open_round needs to create the next round's pot vault. */
async function openRoundPotAccounts(nextRoundId: number) {
  const cfg: any = await program.account.gameConfig.fetch(configPda);
  const sgdMint: PK = cfg.sgdMint;
  if (sgdMint.equals(PublicKey.default)) {
    throw new Error(
      "GameConfig.sgd_mint is unset — run `set_sgd_mint` before opening a round, or " +
      "open_round will fail with SgdMintNotSet.",
    );
  }
  const potAuthority = potAuthorityPda(nextRoundId);
  return {
    potAuthority,
    potVault: ataFor(potAuthority, sgdMint),
    sgdMint,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  };
}
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
  async function sendTxHttp(
    tx: anchor.web3.Transaction, label: string,
    signer: anchor.web3.Keypair = authority,
    // `pay_sol_prizes` needs the treasury's signature for its own lamports while the
    // operator still pays the fee and the marker rent.
    extraSigners: anchor.web3.Keypair[] = [],
  ): Promise<string> {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const bh = await conn.getLatestBlockhash({ commitment: "confirmed" });
      tx.recentBlockhash = bh.blockhash;
      tx.lastValidBlockHeight = bh.lastValidBlockHeight;
      tx.feePayer = signer.publicKey;
      tx.signatures = [];
      tx.sign(signer, ...extraSigners);
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

  // Player-facing name for a winner whose FlowerRecord no longer exists. Owners may close a
  // flower after the round and reclaim its rent, which deletes the only source of its species
  // and generation. Rank and wallet — what the podium is actually about — are still known, so
  // the winner is recorded rather than dropped. Matches the set-round-results edge function,
  // which resolves the same case the same way, so the two writers agree on what they store.
  const CLOSED_FLOWER_NAME = "Retired Bloom";

  // Persist a finished round's results to Supabase so the frontend Daily Winners panel can show
  // them. Server-side write with the SERVICE key (bypasses RLS). Skipped silently when
  // SUPABASE_URL/SERVICE_KEY aren't configured, and never fatal to the reveal itself.
  //
  // Writes are ON CONFLICT DO NOTHING (upsert + ignoreDuplicates). This is about handling a
  // re-run gracefully, NOT about preventing duplication — that is already impossible since the
  // 2026-08-13 migration keyed round_results by round_number and round_winners by the composite
  // (round_number, rank); both are declared in the frontend's supabase/round_results.sql. What
  // it changes is the report: a second write would otherwise raise 23505 and log a scary
  // failure for what is really a no-op. That now matters routinely, because set-round-results
  // may already have published this round from the Operator Panel.
  async function saveResultsToSupabase(roundNumber: number, round: any, scored: any[]) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      // NOT silent: skipping here means the round is revealed on-chain but invisible to the
      // frontend's Daily Winners panel, which previously looked like a frontend bug. The
      // usual cause is `source .env` without `set -a` (vars set but not EXPORTED).
      console.log(`  ⚠ SUPABASE_URL/SUPABASE_SERVICE_KEY not set — results NOT saved to Supabase.`);
      console.log(`    Daily Winners will keep showing the previous round. Re-run with:`);
      console.log(`      set -a; source .env; set +a`);
      return;
    }

    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(url, key);

    const targetTraits: number[] = (round.targetTraits as number[]).slice(0, round.targetTraitCount);

    // round_results — one summary row for the round. `.select()` reports what was actually
    // written: an empty array means the row already existed and the conflict was ignored.
    const results = await supabase
      .from("round_results")
      .upsert(
        {
          round_number: roundNumber,
          target_traits: JSON.stringify(targetTraits),
          total_entrants: round.participantCount,
          completed_at: new Date().toISOString(),
        },
        { onConflict: "round_number", ignoreDuplicates: true },
      )
      .select("round_number");

    // round_winners — one row per top-3 winner, with the flower's player-facing name + gen.
    const byEntry = new Map<string, any>(scored.map((e) => [(e.pubkey as PK).toBase58(), e]));
    const top: PK[] = [round.top1, round.top2, round.top3];
    const winnerRows: WinnerRow[] = [];
    for (let i = 0; i < top.length; i++) {
      const entry = byEntry.get(top[i].toBase58());
      if (!entry) continue;
      // fetchNullable, NOT fetch: fetch() THROWS on a closed account, and a winner may have
      // closed their flower after the round. Thrown from here it would abort the caller
      // mid-sequence, with the reveal already landed on-chain but the results never written —
      // and this is now one of two writers for these tables, so a crash leaves the Daily
      // Winners row missing while the edge-function path would have published it. Devnet
      // round 24 already has exactly this: a winning entry whose FlowerRecord is gone.
      const flower: any = await program.account.flowerRecord.fetchNullable(entry.flowerRecord);
      winnerRows.push({
        round_number: roundNumber,
        rank: i + 1,
        wallet_address: (entry.player as PK).toBase58(),
        flower_name: flower
          ? flowerName(flower.visualSpeciesId, flower.flowerIndex)
          : CLOSED_FLOWER_NAME,
        generation: flower ? flower.generation : 0,
      });
    }
    const winners = winnerRows.length
      ? await supabase
          .from("round_winners")
          .upsert(winnerRows, { onConflict: "round_number,rank", ignoreDuplicates: true })
          .select("rank")
      : null;

    if (results.error || winners?.error) {
      console.log(`  (Supabase write error: ${(results.error ?? winners!.error)!.message})`);
      return;
    }
    const wrote = (results.data?.length ?? 0) > 0 || (winners?.data?.length ?? 0) > 0;
    console.log(wrote ? `Results saved to Supabase` : `Results were already published to Supabase`);
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
          ...(await openRoundPotAccounts(current + 1)),
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
            ...queueAccsFor("score_entry_v2", offset),
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

    // ------------------------------------------------------------ DISTRIBUTE
    // Pays a FINALIZED, revealed round's SOL prize pool from the treasury to its winners.
    //
    // WHY THIS EXISTS. auto-cycle pays prizes as step 3b of its own run, and refuses to pay a
    // round it did not itself reveal — a deliberate double-pay guard, because there is no
    // on-chain payout ledger to consult. The gap that leaves: a round cycled by hand through
    // this tool (close/score/reveal/finalize) is never paid by anyone, and auto-cycle will
    // decline to backfill it. That is not hypothetical — it is how rounds 63, 65 and 67 ended
    // up owing their winners, and the operator's only signal was a warning line in a cron log.
    //
    // The guard here is the same idea, made checkable: scan the treasury's own transfer
    // history for a batch whose recipient set is exactly this round's winners and which lands
    // after the round closed. If one exists, this round has been paid and we refuse. It is a
    // heuristic — SOL transfers carry no memo tying them to a round — but it is the same
    // evidence a human would use, applied consistently instead of from memory.
    //
    //   COMMAND=distribute ROUND=63 TREASURY_PRIVATE_KEY='[...]' ...
    //   COMMAND=distribute ROUND=63 DRY_RUN=1 ...      # report only, sends nothing
    if (COMMAND === "distribute") {
      const roundId = Number(process.env.ROUND ?? current);
      const dry = process.env.DRY_RUN === "1";
      if (!Number.isInteger(roundId) || roundId <= 0) throw new Error("set ROUND=<n>");

      const round = roundPda(roundId);
      const r: any = await program.account.competitionRound.fetch(round);
      if (r.status !== ROUND_STATUS_FINALIZED) throw new Error(`round ${roundId} is not FINALIZED (status ${r.status})`);
      if (!r.scoringRevealed) throw new Error(`round ${roundId} has no revealed winners`);

      // top1/2/3 hold CompetitionEntry pubkeys; the wallet is on the entry, not the round.
      const winners: PK[] = [];
      for (const e of [r.top1, r.top2, r.top3] as PK[]) {
        if (e.equals(PublicKey.default)) continue;
        const entry: any = await program.account.competitionEntry.fetch(e);
        winners.push(entry.player as PK);
      }
      if (winners.length === 0) throw new Error(`round ${roundId} revealed no real winners`);
      console.log(`\nRound ${roundId}: ${winners.length} winner(s)`);
      winners.forEach((w, i) => console.log(`  rank ${i + 1}: ${w.toBase58()}  ${PRIZE_SOL[i] ?? 0} SOL`));

      const treasuryKey = process.env.TREASURY_PRIVATE_KEY;
      if (!treasuryKey) throw new Error("TREASURY_PRIVATE_KEY not set");
      const treasury = Keypair.fromSecretKey(new Uint8Array(JSON.parse(treasuryKey)));
      console.log(`  treasury : ${treasury.publicKey.toBase58()}`);

      // --- guard: the on-chain marker, not a guess ------------------------------------
      //
      // This used to infer payment by intersecting the winner's and the treasury's transaction
      // histories, because SOL prizes had no on-chain ledger. That inference had an unbounded
      // forward window, so a winner who also won a LATER round read as proof the earlier one
      // was settled, and it matched on ANY shared transaction rather than a transfer of the
      // right size in the right direction. It could say "already paid" when nothing was paid.
      //
      // `pay_sol_prizes` now writes a PrizeDistribution marker atomically with the transfers,
      // so for any round settled after that upgrade the question is a getAccountInfo.
      const [prizeDist] = PublicKey.findProgramAddressSync(
        [Buffer.from("prize_dist"), u64le(roundId)], program.programId);
      if (await conn.getAccountInfo(prizeDist, "confirmed")) {
        console.log(`\n  ALREADY PAID — PrizeDistribution marker exists for round ${roundId}.`);
        console.log(`  Refusing to double-pay.`);
        return;
      }

      // THE MARKER IS ONLY AUTHORITATIVE GOING FORWARD. Rounds paid BEFORE the marker shipped
      // have no marker and never will, so "no marker" does not mean "unpaid" for them — it
      // means "unknowable from chain state". Paying one of those again is real money, so this
      // refuses to guess and makes the operator assert it, having checked by hand.
      //
      // `PRIZE_MARKER_FIRST_ROUND` is the first round opened after the upgrade; anything below
      // it predates the ledger. Raise it, never lower it.
      if (roundId < PRIZE_MARKER_FIRST_ROUND && process.env.BACKFILL !== "1") {
        console.log(`\n  ROUND ${roundId} PREDATES THE ON-CHAIN PRIZE LEDGER.`);
        console.log(`  No PrizeDistribution marker exists, and for a pre-upgrade round that is`);
        console.log(`  NOT evidence it went unpaid — the old flow paid prizes and recorded`);
        console.log(`  nothing. Verify by hand (check the treasury's transfers to each winner`);
        console.log(`  around ${new Date(r.endTime.toNumber() * 1000).toISOString()}), then`);
        console.log(`  re-run with BACKFILL=1 to override.`);
        console.log(`  Winners: ${winners.map((w) => w.toBase58()).join(", ")}`);
        return;
      }
      if (roundId < PRIZE_MARKER_FIRST_ROUND) {
        console.log(`\n  BACKFILL=1 — paying a pre-ledger round on the operator's assertion.`);
      }

      const total = winners.reduce((sum, _w, i) => sum + (PRIZE_SOL[i] ?? 0), 0);
      const bal = (await conn.getBalance(treasury.publicKey)) / LAMPORTS_PER_SOL;
      console.log(`  owed     : ${total} SOL   (treasury holds ${bal.toFixed(4)})`);
      if (bal < total + 0.01) throw new Error("treasury balance too low");
      if (dry) { console.log("\n  [dry run — nothing sent]"); return; }

      // Post-ledger rounds go through the program, so the payout and its receipt are one
      // transaction. Pre-ledger backfills fall back to bare transfers: `pay_sol_prizes` would
      // write a marker dated today for money that may have moved weeks ago, which is a worse
      // lie than no marker at all.
      if (roundId >= PRIZE_MARKER_FIRST_ROUND) {
        const entries: PK[] = [];
        for (const e of [r.top1, r.top2, r.top3] as PK[]) {
          if (!e.equals(PublicKey.default)) entries.push(e);
        }
        const tx = await program.methods
          .paySolPrizes(winners.map((_w, i) =>
            new BN(Math.round((PRIZE_SOL[i] ?? 0) * LAMPORTS_PER_SOL))))
          .accountsPartial({
            authority: authority.publicKey, treasury: treasury.publicKey,
            config: configPda, round, prizeDistribution: prizeDist,
          })
          .remainingAccounts(entries.flatMap((e, i) => [
            { pubkey: e, isSigner: false, isWritable: false },
            { pubkey: winners[i], isSigner: false, isWritable: true },
          ]))
          .transaction();
        const sig = await sendTxHttp(tx, `paySolPrizes(${roundId})`, undefined, [treasury]);
        console.log(`    paid ${total} SOL and wrote the marker  ${sig ?? ""}`);
      } else {
        for (let i = 0; i < winners.length; i++) {
          const sol = PRIZE_SOL[i] ?? 0;
          if (sol <= 0) continue;
          const tx = new anchor.web3.Transaction().add(SystemProgram.transfer({
            fromPubkey: treasury.publicKey, toPubkey: winners[i],
            lamports: Math.round(sol * LAMPORTS_PER_SOL),
          }));
          const sig = await sendTxHttp(tx, `prize rank ${i + 1} (${sol} SOL)`, treasury);
          console.log(`    rank ${i + 1} -> ${winners[i].toBase58()}  ${sol} SOL  ${sig ?? ""}`);
        }
      }
      console.log(`\nRound ${roundId}: paid ${total} SOL to ${winners.length} winner(s).`);
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
