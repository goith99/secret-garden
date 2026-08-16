/**
 * Batch migration driver: grow every pre-5E `FlowerRecord` (528 bytes) to the 5E layout
 * (529 bytes) via the operator-signed `operator_migrate_flower`.
 *
 * WHY THIS IS NEEDED. Stage 5E appends `times_bred_as_parent: u8` to `FlowerRecord`, which
 * has no spare bytes (`space = 8 + INIT_SPACE`, an exact fit). Anchor cannot read a record
 * that is one byte short — it fails with AccountDidNotDeserialize (0xbbb) — and
 * `FlowerRecord` is bound as a typed `Account` in 8 instruction contexts. So the moment the
 * 5E program is deployed, EVERY un-migrated flower is unbreedable, unsubmittable,
 * unscoreable, un-hintable and unclosable until it is reallocated. This script closes that
 * window in one operator-funded pass.
 *
 * WHY OPERATOR-SIGNED. `migrate_flower` is self-service and needs the owner's signature, so
 * it can only ever migrate flowers whose key we hold — 1 of 85 wallets on dev, and none of
 * the real players' in production (241 distinct owners here). `operator_migrate_flower` takes the owner as a bare
 * account used only to derive the PDA, so one funded wallet migrates the whole population.
 * It grants no power over flower contents: the handler only reads the account's length,
 * transfers rent, and calls `resize`, which appends zero bytes and cannot alter existing
 * ones.
 *
 * DRY RUN BY DEFAULT. It prints exactly what it would migrate, what it would cost, and
 * whether the operator can afford it — and sends nothing unless `--execute` is passed.
 *
 * RESUMABLE. `operator_migrate_flower` returns early when the account is already at the new
 * size, and this script re-enumerates from chain on every run rather than trusting any local
 * index or checkpoint. A re-run after a partial pass costs transaction fees and no rent, so
 * it is always safe to just run it again.
 *
 * PRE-FLIGHT (not enforced here, but do it): migrate under `GameConfig.paused` and let
 * in-flight experiments drain first. `BreedCallback` holds three typed `FlowerRecord`
 * bindings, so a breed queued before the deploy would fail its callback afterwards and hang
 * the experiment.
 *
 * Usage — env must be EXPORTED (`set -a`), and the operator keypair must be the config
 * authority or a registered operator:
 *   set -a; source .env; set +a
 *   node scripts/migrate-flowers-batch.mjs                  # dry run, sends nothing
 *   node scripts/migrate-flowers-batch.mjs --verify         # re-check only, sends nothing
 *   node scripts/migrate-flowers-batch.mjs --execute        # actually migrates, then verifies
 *
 * Options:
 *   --execute            perform the migration (default is a dry run)
 *   --verify             run the verification pass alone and exit
 *   --per-tx=N           flowers per transaction (default 6, clamped to 1..8)
 *   --limit=N            only process the first N pending flowers (useful for a canary run)
 *   --keypair=PATH       operator keypair (default ~/.config/solana/id.json)
 *
 * No key material is embedded: the RPC comes from HELIUS_RPC_URL and the keypair from disk.
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

const LEGACY_LEN = 528; // pre-5E on-chain size, discriminator included (verified on production)
const CURRENT_LEN = 529; // 5E layout (8 disc + 521 body)
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
async function enumerateFlowers() {
  const disc = accountDisc("FlowerRecord");
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
 * Read `owner` (bytes 8..40) and `flower_index` (bytes 40..44) straight out of each pending
 * account. Deliberately NOT derived from any local list of wallets: the chain is the only
 * source of truth for who owns what, and the PDA seeds must match byte-for-byte.
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
      const owner = new PublicKey(info.data.subarray(8, 40));
      const flowerIndex = info.data.readUInt32LE(40);
      // Prove the seeds actually reproduce this address before we ever send it.
      const [derived] = PublicKey.findProgramAddressSync(
        [Buffer.from("flower"), owner.toBuffer(), u32le(flowerIndex)], programId);
      if (!derived.equals(slice[j])) {
        throw new Error(
          `seed mismatch for ${slice[j].toBase58()}: owner=${owner.toBase58()} index=${flowerIndex} `
          + `derives ${derived.toBase58()} — refusing to send`);
      }
      out.push({ pubkey: slice[j], owner, flowerIndex, lamports: info.lamports, size: info.data.length });
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
        .operatorMigrateFlower(t.flowerIndex)
        .accountsStrict({
          authority: operator.publicKey,
          config: configPda,
          owner: t.owner,
          flower: t.pubkey,
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
  const { total, pending, migrated, unknown } = await enumerateFlowers();
  log(`  FlowerRecords total : ${total}`);
  log(`  at ${CURRENT_LEN} (migrated)   : ${migrated.length}`);
  log(`  at ${LEGACY_LEN} (pending)    : ${pending.length}`);
  if (unknown.length) log(`  unexpected sizes    : ${unknown.length}`);

  let ok = pending.length === 0 && unknown.length === 0;
  if (!ok) {
    log(`\n  RESULT: INCOMPLETE — ${pending.length} still on the old layout.`);
  }

  // Spot-decode: prove they genuinely deserialize, not merely that the byte count is right.
  const sample = migrated.slice(0, sampleSize);
  if (sample.length) {
    log(`\n  spot-decoding ${sample.length} migrated records:`);
    for (const pk of sample) {
      try {
        const f = await program.account.flowerRecord.fetch(pk);
        const good = f.timesBredAsParent === 0 || f.timesBredAsParent <= 3;
        if (!good) ok = false;
        log(`    ${pk.toBase58()}  gen=${f.generation} rarity=${f.rarity} `
          + `timesBredAsParent=${f.timesBredAsParent}  ${good ? "OK" : "**BAD**"}`);
      } catch (e) {
        ok = false;
        log(`    ${pk.toBase58()}  **DECODE FAILED**: ${String(e.message).slice(0, 80)}`);
      }
    }
  }
  log(`\n  RESULT: ${ok ? "PASS — every FlowerRecord is on the 5E layout and decodes cleanly"
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
  const { total, pending, migrated, unknown } = await enumerateFlowers();
  log(`  FlowerRecords total : ${total}`);
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
  log(`\n=== READ SEEDS (owner @8..40, flower_index @40..44) ===`);
  let targets = await readSeeds(pending);
  const owners = new Set(targets.map((t) => t.owner.toBase58()));
  log(`  ${targets.length} pending flowers across ${owners.size} distinct owners`);
  const perOwner = [...owners].map((o) => targets.filter((t) => t.owner.toBase58() === o).length);
  log(`  flowers per owner: min ${Math.min(...perOwner)}, max ${Math.max(...perOwner)}, `
    + `mean ${(targets.length / owners.size).toFixed(1)}`);
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
  log(`  rent per flower     : ${rentDelta} lamports (${sol(rentDelta)})`
    + `${rentDelta === EXPECTED_RENT_DELTA ? "" : `  [expected ${EXPECTED_RENT_DELTA}]`}`);
  log(`  flowers to migrate  : ${targets.length}`);
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
    log(`  tx ${String(i + 1).padStart(3)}: ${chunk.length} flowers`);
    for (const t of chunk.slice(0, 2)) {
      log(`         ${t.pubkey.toBase58()}  owner=${t.owner.toBase58().slice(0, 8)}… idx=${t.flowerIndex}`);
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
    log(`  ${label}: ${chunk.length} flowers OK  (${done}/${targets.length}, ${pct}%)  ${sig.slice(0, 16)}…`);
  }
  const spent = balance - (await conn.getBalance(operator.publicKey));
  log(`\n  migrated ${done} flowers in ${txCount} transactions, `
    + `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  log(`  operator spent: ${spent} lamports (${sol(spent)})  [estimated ${sol(costTotal)}]`);

  process.exit((await verify()) ? 0 : 1);
})().catch((e) => {
  console.error(`\nFATAL: ${e.message}`);
  process.exit(1);
});
