/**
 * Grows the singleton GameConfig to the CURRENT program's layout, and proves it worked.
 *
 * THIS MUST BE THE FIRST TRANSACTION AFTER ANY UPGRADE THAT GROWS `GameConfig`. 44 instruction
 * contexts take a typed `Account<GameConfig>`; between the upgrade landing and this running,
 * every one of them fails with AccountDidNotDeserialize (0xbbb) and the whole game is down —
 * not just the new instructions. That is not a theoretical window: it is the near-miss this
 * project has already had once, and the reason this script exists as a repo artifact rather
 * than a command someone remembers to type.
 *
 * `migrate_config` is generic (resize to 8 + INIT_SPACE, zero-fill) and idempotent — an
 * already-grown config is a no-op — so it is safe to run before the upgrade as a rehearsal.
 *
 *   set -a; source .env; set +a
 *   node scripts/migrate-config.mjs             # simulate only
 *   node scripts/migrate-config.mjs --execute
 */
import * as anchor from "@anchor-lang/core";
import fs from "fs"; import os from "os";
const { PublicKey, Keypair, Connection } = anchor.web3;

const RPC = process.env.HELIUS_RPC_URL ?? "https://api.devnet.solana.com";
const EXECUTE = process.argv.includes("--execute");

const conn = new Connection(RPC, "confirmed");
const authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${os.homedir()}/.config/solana/id.json`).toString())));
const idl = JSON.parse(fs.readFileSync("./target/idl/secret_garden.json").toString());
const program = new anchor.Program(idl, new anchor.AnchorProvider(
  conn, new anchor.Wallet(authority), { commitment: "confirmed" }));
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);

// What the LOCAL build expects, derived from the IDL rather than hardcoded, so this script
// cannot drift from the program it ships beside.
const gc = idl.types.find((t) => t.name === "GameConfig").type.fields;
const SIZE = { pubkey: 32, u64: 8, i64: 8, u8: 1, bool: 1 };
const fieldLen = (t) => typeof t === "string" ? SIZE[t]
  : t.array ? fieldLen(t.array[0]) * t.array[1] : (() => { throw new Error(`unhandled ${JSON.stringify(t)}`); })();
const expected = 8 + gc.reduce((n, f) => n + fieldLen(f.type), 0);

const info = await conn.getAccountInfo(configPda, "confirmed");
if (!info) throw new Error("config account not found");

console.log(`program  : ${program.programId.toBase58()}`);
console.log(`config   : ${configPda.toBase58()}`);
console.log(`on-chain : ${info.data.length} bytes`);
console.log(`expected : ${expected} bytes  (${gc.map((f) => f.name).join(", ")})`);

if (info.data.length === expected) {
  console.log(`\nAlready at the current layout — migrate_config would be a no-op.`);
} else if (info.data.length > expected) {
  console.log(`\nOn-chain account is LARGER than this build expects. That means the deployed`);
  console.log(`program is AHEAD of this source tree. Do not migrate; reconcile first.`);
  process.exit(1);
} else {
  const rent = await conn.getMinimumBalanceForRentExemption(expected);
  console.log(`\nNeeds to grow ${expected - info.data.length} bytes.`);
  console.log(`rent for ${expected} bytes: ${(rent / 1e9).toFixed(6)} SOL (holds ${(info.lamports / 1e9).toFixed(6)})`);
  if (rent > info.lamports) console.log(`  top-up of ${((rent - info.lamports) / 1e9).toFixed(6)} SOL comes from the authority`);
}

const tx = await program.methods.migrateConfig()
  .accountsPartial({ authority: authority.publicKey, config: configPda })
  .transaction();
tx.feePayer = authority.publicKey;
tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;

const sim = await conn.simulateTransaction(tx);
console.log(`\nsimulation: ${sim.value.err ? "FAILED " + JSON.stringify(sim.value.err) : "OK"}`);
if (sim.value.err) { (sim.value.logs ?? []).slice(-8).forEach((l) => console.log("  " + l)); process.exit(1); }

if (!EXECUTE) { console.log("\n[dry run — nothing sent]"); process.exit(0); }

tx.sign(authority);
const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
await conn.confirmTransaction(sig, "confirmed");
console.log(`\nmigrate_config sig: ${sig}`);

// The real proof: a TYPED fetch. If the account is still the old size this throws, which is
// exactly the failure every other instruction would hit.
const after = await conn.getAccountInfo(configPda, "confirmed");
const cfg = await program.account.gameConfig.fetch(configPda);
console.log(`size after      : ${after.data.length} bytes (expected ${expected})`);
console.log(`typed fetch     : OK`);
console.log(`  authority        ${cfg.authority.toBase58()}`);
console.log(`  currentRound     ${cfg.currentRound.toString()}`);
console.log(`  paused           ${cfg.paused}`);
console.log(`  sgdMint          ${cfg.sgdMint.toBase58()}`);
console.log(`  pendingAuthority ${cfg.pendingAuthority.toBase58()}`);
console.log(`  operatorCount    ${cfg.operatorCount}`);
console.log(`  mutantWeight     ${cfg.mutantWeight}`);
if (after.data.length !== expected) { console.error("SIZE MISMATCH after migration"); process.exit(1); }
