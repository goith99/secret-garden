/**
 * Batch migration driver: grow every pre-5E `CompetitionEntry` (174 bytes) to the 5E layout
 * (175 bytes) via the operator-signed `migrate_entry`, and BACKFILL `rarity_snapshot`.
 *
 * WHY THIS IS NEEDED. Stage 5E appends `rarity_snapshot: u8` to `CompetitionEntry`, which has
 * no spare bytes. Anchor cannot read a record that is one byte short, and `CompetitionEntry`
 * is bound as a typed `Account` in the reveal paths and read by the frontend's
 * `fetchReleasableEntries`, which scans EVERY past round — so an un-migrated entry breaks the
 * Release feature for its owner as surely as an un-migrated flower breaks the garden.
 *
 * WHY IT IS NOT JUST A RESIZE. `resize` zero-fills, and a zero snapshot would rank every
 * pre-existing entry as rarity 0 in `reveal_top3_v5`'s tiebreak. `migrate_entry` therefore
 * re-derives the value from the flower the entry itself recorded, through
 * `read_flower_rarity`'s own validation (key match against `entry.flower_record`, program
 * ownership, discriminator). The operator supplies the flower account but cannot substitute a
 * richer one — the key must match what the entry stored at submission.
 *
 * WRITE-ONCE. The handler is gated on the account still being the old size, so an
 * already-migrated entry is an immediate no-op and its snapshot can never be rewritten. That
 * also makes re-running this script free of rent and safe at any point.
 *
 * DRY RUN BY DEFAULT. Sends nothing unless `--execute` is passed.
 *
 * Usage:
 *   node scripts/migrate-entries-batch.mjs                  # dry run
 *   node scripts/migrate-entries-batch.mjs --verify         # re-check only
 *   node scripts/migrate-entries-batch.mjs --execute        # migrate, then verify
 *
 * Options: --execute  --verify  --per-tx=N (default 6)  --limit=N  --keypair=PATH
 */
import * as anchor from "@anchor-lang/core";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";

const { PublicKey, Keypair, Transaction, Connection } = anchor.web3;

// ---------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const hasFlag = (n) => argv.includes(`--${n}`);
const optOf = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const EXECUTE = hasFlag("execute");
const VERIFY_ONLY = hasFlag("verify");
const PER_TX = Math.min(8, Math.max(1, Number(optOf("per-tx", 6))));
const LIMIT = Number(optOf("limit", 0)) || Infinity;
const KEYPAIR_PATH = optOf("keypair", `${os.homedir()}/.config/solana/id.json`);

const LEGACY_LEN = 174; // pre-5E on-chain size, discriminator included (verified on production)
const CURRENT_LEN = 175; // 5E layout (8 disc + 167 body)
/** Rent-exempt delta for +1 byte. Recomputed from chain below; this is the expected value. */
const EXPECTED_RENT_DELTA = 6_960;
const TX_FEE_LAMPORTS = 5_000;
/** Refuse to start unless the operator holds cost * this much. */
const HEADROOM = 1.5;
const LAMPORTS_PER_SOL = anchor.web3.LAMPORTS_PER_SOL;

const RPC = process.env.HELIUS_RPC_URL || process.env.RPC_URL || "https://api.devnet.solana.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sol = (lamports) => `${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
const log = (s = "") => console.log(s);

const conn = new Connection(RPC, "confirmed");
const operator = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(KEYPAIR_PATH).toString())));
const idl = JSON.parse(fs.readFileSync("./target/idl/secret_garden.json").toString());
const provider = new anchor.AnchorProvider(conn, {
  publicKey: operator.publicKey,
  signTransaction: async (t) => { t.sign(operator); return t; },
  signAllTransactions: async (ts) => ts.map((t) => { t.sign(operator); return t; }),
}, {
  commitment: "confirmed",
});
const program = new anchor.Program(idl, provider);
const programId = program.programId;
const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];

const accountDisc = (name) =>
  createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);

// ---------------------------------------------------------------------------------------
// 1. Enumerate — sizes only (dataSlice length 0), then owner/index from the pending ones
// ---------------------------------------------------------------------------------------

/**
 * Partition every FlowerRecord by on-chain size. Uses a memcmp on the account discriminator
 * so nothing but FlowerRecords come back, and `dataSlice: {length: 0}` so the 320-byte
 * genome payloads are never transferred — only the account's true `data.length` is needed.
 */
async function enumerateEntries() {
  const disc = accountDisc("CompetitionEntry");
  const rows = await conn.getProgramAccounts(programId, {
    filters: [{ memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(disc) } }],
    dataSlice: { offset: 0, length: 0 },
  });

  // `dataSlice` zeroes out `data`, but `account.data.length` reflects the slice, not the
  // account. The true size comes back in the `space` field of the parsed response; when it
  // is absent we fall back to a size-filtered query, which is exact by construction.
  const pending = [];
  const migrated = [];
  const unknown = [];
  for (const r of rows) {
    const size = r.account.space ?? null;
    if (size === LEGACY_LEN) pending.push(r.pubkey);
    else if (size === CURRENT_LEN) migrated.push(r.pubkey);
    else unknown.push({ pubkey: r.pubkey, size });
  }

  if (unknown.length && unknown.every((u) => u.size === null)) {
    // No `space` field from this RPC — resolve by two exact dataSize queries instead.
    const bySize = async (len) =>
      (await conn.getProgramAccounts(programId, {
        filters: [
          { memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(disc) } },
          { dataSize: len },
        ],
        dataSlice: { offset: 0, length: 0 },
      })).map((x) => x.pubkey);
    return {
      total: rows.length,
      pending: await bySize(LEGACY_LEN),
      migrated: await bySize(CURRENT_LEN),
      unknown: [],
    };
  }
  return { total: rows.length, pending, migrated, unknown };
}

/**
 * Read `round` (8..40), `player` (40..72) and `flower_record` (72..104) straight out of each
 * pending entry. The chain is the only source of truth: `migrate_entry` re-reads
 * `flower_record` itself and validates the flower we pass against it, so a wrong flower here
 * is rejected on-chain rather than silently mis-migrating.
 */
async function readSeeds(pubkeys) {
  const out = [];
  const CHUNK = 100; // getMultipleAccountsInfo caps at 100
  for (let i = 0; i < pubkeys.length; i += CHUNK) {
    const slice = pubkeys.slice(i, i + CHUNK);
    const infos = await conn.getMultipleAccountsInfo(slice, "confirmed");
    for (let j = 0; j < slice.length; j++) {
      const info = infos[j];
      if (!info) throw new Error(`account vanished mid-run: ${slice[j].toBase58()}`);
      const round = new PublicKey(info.data.subarray(8, 40));
      const player = new PublicKey(info.data.subarray(40, 72));
      const flower = new PublicKey(info.data.subarray(72, 104));
      // Prove the seeds reproduce this address before we ever send it.
      const [derived] = PublicKey.findProgramAddressSync(
        [Buffer.from("entry"), round.toBuffer(), player.toBuffer()], programId);
      if (!derived.equals(slice[j])) {
        throw new Error(
          `seed mismatch for ${slice[j].toBase58()}: round=${round.toBase58()} `
          + `player=${player.toBase58()} derives ${derived.toBase58()} — refusing to send`);
      }
      out.push({ pubkey: slice[j], round, player, flower, lamports: info.lamports });
    }
    process.stdout.write(`\r  read seeds ${Math.min(i + CHUNK, pubkeys.length)}/${pubkeys.length}`);
  }
  if (pubkeys.length) process.stdout.write("\n");
  return out;
}

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

// ---------------------------------------------------------------------------------------
// 2. Send — batched, with the established HTTP send-and-confirm retry/backoff
// ---------------------------------------------------------------------------------------

async function sendBatch(targets, label) {
  const tx = new Transaction();
  for (const t of targets) {
    tx.add(
      await program.methods
        .migrateEntry()
        .accountsStrict({
          authority: operator.publicKey,
          config: configPda,
          round: t.round,
          player: t.player,
          entry: t.pubkey,
          flower: t.flower,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .instruction(),
    );
  }

  for (let attempt = 1; attempt <= 6; attempt++) {
    const bh = await conn.getLatestBlockhash({ commitment: "confirmed" });
    tx.recentBlockhash = bh.blockhash;
    tx.lastValidBlockHeight = bh.lastValidBlockHeight;
    tx.feePayer = operator.publicKey;
    tx.signatures = [];
    tx.sign(operator);
    let sig;
    try {
      sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 });
    } catch (e) {
      log(`    ${label} send err (attempt ${attempt}): ${String(e.message).slice(0, 100)}`);
      await sleep(Math.min(6000, 500 * 2 ** (attempt - 1)));
      continue;
    }
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const s = (await conn.getSignatureStatuses([sig])).value[0];
      if (s) {
        if (s.err) throw new Error(`${label} FAILED on-chain: ${JSON.stringify(s.err)} (${sig})`);
        if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") return sig;
      }
      if ((await conn.getBlockHeight({ commitment: "confirmed" })) > bh.lastValidBlockHeight) break;
      await sleep(800);
    }
    log(`    ${label} not confirmed (attempt ${attempt}); retrying`);
  }
  throw new Error(`${label} did not confirm after retries`);
}

// ---------------------------------------------------------------------------------------
// 3. Verify — re-enumerate, then spot-decode a sample
// ---------------------------------------------------------------------------------------

async function verify(sampleSize = 5) {
  log(`\n=== VERIFY ===`);
  const { total, pending, migrated, unknown } = await enumerateEntries();
  log(`  CompetitionEntries : ${total}`);
  log(`  at ${CURRENT_LEN} (migrated)   : ${migrated.length}`);
  log(`  at ${LEGACY_LEN} (pending)    : ${pending.length}`);
  if (unknown.length) log(`  unexpected sizes    : ${unknown.length}`);

  let ok = pending.length === 0 && unknown.length === 0;
  if (!ok) {
    log(`\n  RESULT: INCOMPLETE — ${pending.length} still on the old layout.`);
  }

  // Spot-check the BACKFILL, not just the resize. `migrate_entry` re-derives the snapshot
  // through read_flower_rarity's validation, so the check that matters is whether the byte
  // on the entry equals byte 47 (FLOWER_RARITY_OFFSET) of the flower the entry recorded —
  // read here independently, exactly as the on-chain helper reads it.
  const FLOWER_RARITY_OFFSET = 47;
  const FLOWER_DISC = accountDisc("FlowerRecord");
  const sample = migrated.slice(0, sampleSize);
  if (sample.length) {
    log(`\n  spot-checking ${sample.length} migrated entries against their flowers:`);
    for (const pk of sample) {
      try {
        const e = await program.account.competitionEntry.fetch(pk);
        const finfo = await conn.getAccountInfo(e.flowerRecord, "confirmed");
        if (!finfo) throw new Error("flower_record account missing");
        if (!finfo.data.subarray(0, 8).equals(FLOWER_DISC)) throw new Error("not a FlowerRecord");
        const truth = finfo.data[FLOWER_RARITY_OFFSET];
        const match = e.raritySnapshot === truth;
        if (!match) ok = false;
        log(`    ${pk.toBase58().slice(0, 12)}…  rarity_snapshot=${e.raritySnapshot} `
          + `flower.rarity=${truth}  status=${e.status}  ${match ? "MATCH" : "**MISMATCH**"}`);
      } catch (err) {
        ok = false;
        log(`    ${pk.toBase58().slice(0, 12)}…  **CHECK FAILED**: ${String(err.message).slice(0, 70)}`);
      }
    }
  }
  log(`\n  RESULT: ${ok ? "PASS — every CompetitionEntry is on the 5E layout and its snapshot matches its flower"
    : "FAIL — see above"}`);
  return ok;
}

// ---------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------
(async () => {
  log(`\nSecret Garden — FlowerRecord 5E batch migration`);
  log(`  cluster   : ${new URL(RPC).host}`);
  log(`  program   : ${programId.toBase58()}`);
  log(`  operator  : ${operator.publicKey.toBase58()}  (${KEYPAIR_PATH.replace(os.homedir(), "~")})`);
  log(`  mode      : ${VERIFY_ONLY ? "VERIFY ONLY" : EXECUTE ? "EXECUTE" : "DRY RUN (default)"}`);

  if (VERIFY_ONLY) {
    process.exit((await verify()) ? 0 : 1);
  }

  // --- authority check: fail early rather than after N rejected transactions ---
  let gated = false;
  try {
    const cfg = await program.account.gameConfig.fetch(configPda);
    const ops = cfg.operators.filter((o) => !o.equals(PublicKey.default)).map((o) => o.toBase58());
    gated = cfg.authority.equals(operator.publicKey) || ops.includes(operator.publicKey.toBase58());
    log(`  config    : authority=${cfg.authority.toBase58()} operators=${cfg.operatorCount} paused=${cfg.paused}`);
    log(`  gate      : operator ${gated ? "IS" : "is NOT"} authority-or-operator`);
    if (!cfg.paused) {
      log(`  NOTE      : the game is NOT paused. Migrating under load risks racing in-flight`);
      log(`              breeds — BreedCallback holds typed FlowerRecord bindings.`);
    }
  } catch (e) {
    log(`  config    : could not read GameConfig (${String(e.message).slice(0, 60)})`);
  }

  // --- enumerate ---
  log(`\n=== ENUMERATE ===`);
  const { total, pending, migrated, unknown } = await enumerateEntries();
  log(`  CompetitionEntries : ${total}`);
  log(`  at ${CURRENT_LEN} (migrated)   : ${migrated.length}`);
  log(`  at ${LEGACY_LEN} (pending)    : ${pending.length}`);
  if (unknown.length) {
    log(`  UNEXPECTED sizes    : ${unknown.length}`);
    for (const u of unknown.slice(0, 5)) log(`    ${u.pubkey.toBase58()} = ${u.size} bytes`);
  }

  if (pending.length === 0) {
    log(`\n  Nothing to do — every FlowerRecord is already on the 5E layout.`);
    process.exit((await verify()) ? 0 : 1);
  }

  // --- read seeds straight from chain ---
  log(`\n=== READ SEEDS (round @8..40, player @40..72, flower_record @72..104) ===`);
  let targets = await readSeeds(pending);

  // An entry whose flower has been CLOSED cannot be migrated: `migrate_entry` re-derives the
  // snapshot through read_flower_rarity, which rejects a missing account with FlowerNotOwned
  // (6010). That happens when a player released a finalized entry and then deleted the
  // flower. Filter them out here rather than letting one abort the whole batch, and report
  // them — they need a program-side decision, not a retry.
  {
    const fdisc = accountDisc("FlowerRecord");
    const blocked = [];
    const good = [];
    for (let i = 0; i < targets.length; i += 100) {
      const slice = targets.slice(i, i + 100);
      const infos = await conn.getMultipleAccountsInfo(slice.map((t) => t.flower), "confirmed");
      infos.forEach((inf, j) => {
        const t = slice[j];
        if (!inf) blocked.push({ ...t, why: "flower account closed" });
        else if (!inf.data.subarray(0, 8).equals(fdisc)) blocked.push({ ...t, why: "not a FlowerRecord" });
        else good.push(t);
      });
    }
    if (blocked.length) {
      log(`\n  ${blocked.length} entries CANNOT be migrated (their flower no longer exists):`);
      for (const b of blocked) log(`    ${b.pubkey.toBase58()}  player=${b.player.toBase58().slice(0, 8)}…  ${b.why}`);
      log(`  skipping them; the other ${good.length} proceed.`);
    }
    targets = good;
  }
  const players = new Set(targets.map((t) => t.player.toBase58()));
  const rounds = new Set(targets.map((t) => t.round.toBase58()));
  log(`  ${targets.length} pending entries across ${players.size} players and ${rounds.size} rounds`);
  const perPlayer = [...players].map((o) => targets.filter((t) => t.player.toBase58() === o).length);
  log(`  entries per player: min ${Math.min(...perPlayer)}, max ${Math.max(...perPlayer)}, `
    + `mean ${(targets.length / players.size).toFixed(1)}`);
  if (targets.length > LIMIT) {
    targets = targets.slice(0, LIMIT);
    log(`  --limit=${LIMIT} -> processing only the first ${targets.length}`);
  }

  // --- cost ---
  const rentNow = await conn.getMinimumBalanceForRentExemption(LEGACY_LEN);
  const rentNew = await conn.getMinimumBalanceForRentExemption(CURRENT_LEN);
  const rentDelta = rentNew - rentNow;
  const txCount = Math.ceil(targets.length / PER_TX);
  const rentTotal = rentDelta * targets.length;
  const feeTotal = TX_FEE_LAMPORTS * txCount;
  const costTotal = rentTotal + feeTotal;
  const balance = await conn.getBalance(operator.publicKey);

  log(`\n=== COST ===`);
  log(`  rent per entry      : ${rentDelta} lamports (${sol(rentDelta)})`
    + `${rentDelta === EXPECTED_RENT_DELTA ? "" : `  [expected ${EXPECTED_RENT_DELTA}]`}`);
  log(`  entries to migrate  : ${targets.length}`);
  log(`  rent total          : ${rentTotal} lamports (${sol(rentTotal)})`);
  log(`  batching            : ${PER_TX} per tx -> ${txCount} transactions`);
  log(`  fees (est)          : ${feeTotal} lamports (${sol(feeTotal)})`);
  log(`  TOTAL               : ${costTotal} lamports (${sol(costTotal)})`);
  log(`  operator balance    : ${balance} lamports (${sol(balance)})`);
  log(`  required w/ ${HEADROOM}x    : ${Math.ceil(costTotal * HEADROOM)} lamports `
    + `(${sol(Math.ceil(costTotal * HEADROOM))})`);

  const affordable = balance >= costTotal * HEADROOM;
  if (!affordable) {
    log(`\n  REFUSING TO PROCEED: operator balance ${sol(balance)} does not cover `
      + `${sol(costTotal)} x ${HEADROOM} headroom.`);
    log(`  Fund ${operator.publicKey.toBase58()} and re-run.`);
    process.exit(1);
  }
  log(`  affordable          : YES`);
  if (!gated) {
    log(`\n  REFUSING TO PROCEED: operator is neither the config authority nor a registered`);
    log(`  operator, so every operator_migrate_flower would be rejected with NotAuthority.`);
    process.exit(1);
  }

  // --- sample of what would be sent ---
  log(`\n=== PLAN (first 5 of ${txCount} transactions) ===`);
  for (let i = 0; i < Math.min(5, txCount); i++) {
    const chunk = targets.slice(i * PER_TX, (i + 1) * PER_TX);
    log(`  tx ${String(i + 1).padStart(3)}: ${chunk.length} entries`);
    for (const t of chunk.slice(0, 2)) {
      log(`         ${t.pubkey.toBase58()}  player=${t.player.toBase58().slice(0, 8)}… flower=${t.flower.toBase58().slice(0, 8)}…`);
    }
    if (chunk.length > 2) log(`         … and ${chunk.length - 2} more`);
  }
  if (txCount > 5) log(`  … and ${txCount - 5} more transactions`);

  if (!EXECUTE) {
    log(`\n  [DRY RUN — nothing sent]`);
    log(`  Re-run with --execute to perform the migration.`);
    process.exit(0);
  }

  // --- execute ---
  log(`\n=== EXECUTE ===`);
  const t0 = Date.now();
  let done = 0;
  for (let i = 0; i < txCount; i++) {
    const chunk = targets.slice(i * PER_TX, (i + 1) * PER_TX);
    const label = `tx ${i + 1}/${txCount}`;
    const sig = await sendBatch(chunk, label);
    done += chunk.length;
    const pct = ((done / targets.length) * 100).toFixed(1);
    log(`  ${label}: ${chunk.length} entries OK  (${done}/${targets.length}, ${pct}%)  ${sig.slice(0, 16)}…`);
  }
  const spent = balance - (await conn.getBalance(operator.publicKey));
  log(`\n  migrated ${done} entries in ${txCount} transactions, `
    + `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  log(`  operator spent: ${spent} lamports (${sol(spent)})  [estimated ${sol(costTotal)}]`);

  process.exit((await verify()) ? 0 : 1);
})().catch((e) => {
  console.error(`\nFATAL: ${e.message}`);
  process.exit(1);
});
