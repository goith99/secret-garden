/**
 * Toggle `GameConfig.paused` — the global kill-switch, authority-only.
 *
 * `scripts/operator.ts` deliberately covers only the round-running commands (open, close,
 * score, reveal, finalize, …); pausing is an administrative action that sits outside that
 * loop, so it lives here rather than being bolted into the operator's command table.
 *
 * READ-ONLY BY DEFAULT: with no argument it just reports the current flag.
 *
 * Usage — env must be EXPORTED (`set -a`):
 *   set -a; source .env; set +a
 *   node scripts/set-paused.mjs            # report only, sends nothing
 *   node scripts/set-paused.mjs true       # pause   (>>> sends a transaction <<<)
 *   node scripts/set-paused.mjs false      # unpause (>>> sends a transaction <<<)
 *
 * The signer must be `GameConfig.authority`; operators cannot pause (see
 * `is_operator_or_authority`'s doc comment — pause is authority-only by design).
 */
import * as anchor from "@anchor-lang/core";
import fs from "fs";
import os from "os";

const { PublicKey, Keypair, Connection, Transaction } = anchor.web3;

const RPC = process.env.HELIUS_RPC_URL;
if (!RPC) {
  console.error("FATAL: HELIUS_RPC_URL is not set.  set -a; source .env; set +a");
  process.exit(1);
}
const arg = process.argv[2];
if (arg !== undefined && arg !== "true" && arg !== "false") {
  console.error(`FATAL: argument must be "true" or "false" (got "${arg}")`);
  process.exit(1);
}

const conn = new Connection(RPC, "confirmed");
const authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${os.homedir()}/.config/solana/id.json`).toString())));
const idl = JSON.parse(fs.readFileSync("./target/idl/secret_garden.json").toString());
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(authority), {
  commitment: "confirmed",
});
const program = new anchor.Program(idl, provider);
const configPda = PublicKey.findProgramAddressSync(
  [Buffer.from("config")], program.programId)[0];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const before = await program.account.gameConfig.fetch(configPda);
console.log(`\nconfig    : ${configPda.toBase58()}`);
console.log(`authority : ${before.authority.toBase58()}`);
console.log(`signer    : ${authority.publicKey.toBase58()} `
  + `(${before.authority.equals(authority.publicKey) ? "IS authority" : "NOT authority"})`);
console.log(`round     : ${before.currentRound}`);
console.log(`paused    : ${before.paused}`);

if (arg === undefined) {
  console.log(`\n[report only — nothing sent]`);
  process.exit(0);
}
const want = arg === "true";
if (before.paused === want) {
  console.log(`\nAlready paused=${want} — nothing to do.`);
  process.exit(0);
}
if (!before.authority.equals(authority.publicKey)) {
  console.error(`\nFATAL: signer is not the config authority; set_paused would be rejected.`);
  process.exit(1);
}

console.log(`\nsetting paused: ${before.paused} -> ${want} ...`);
const ix = await program.methods.setPaused(want).accountsStrict({
  authority: authority.publicKey,
  config: configPda,
}).instruction();

// Same HTTP send-and-confirm shape the devnet scripts use (Helius has no WebSocket here).
let sig;
for (let attempt = 1; attempt <= 6; attempt++) {
  const bh = await conn.getLatestBlockhash({ commitment: "confirmed" });
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = bh.blockhash;
  tx.lastValidBlockHeight = bh.lastValidBlockHeight;
  tx.feePayer = authority.publicKey;
  tx.sign(authority);
  try {
    sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 });
  } catch (e) {
    console.log(`  send err (attempt ${attempt}): ${String(e.message).slice(0, 90)}`);
    await sleep(Math.min(6000, 500 * 2 ** (attempt - 1)));
    continue;
  }
  const deadline = Date.now() + 90_000;
  let done = false;
  while (Date.now() < deadline) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st) {
      if (st.err) throw new Error(`set_paused FAILED: ${JSON.stringify(st.err)} (${sig})`);
      if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") {
        done = true;
        break;
      }
    }
    if ((await conn.getBlockHeight({ commitment: "confirmed" })) > bh.lastValidBlockHeight) break;
    await sleep(800);
  }
  if (done) break;
  console.log(`  not confirmed (attempt ${attempt}); retrying`);
}

const after = await program.account.gameConfig.fetch(configPda);
console.log(`  sig       : ${sig}`);
console.log(`  paused now: ${after.paused}`);
if (after.paused !== want) {
  console.error(`FATAL: paused is ${after.paused}, expected ${want}`);
  process.exit(1);
}
console.log(`OK`);
