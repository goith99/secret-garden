/**
 * Pins `GameConfig.sgd_mint` to this deployment's $SGD mint. One-time and authority-only:
 * `set_sgd_mint` refuses a second call (SgdMintAlreadySet, 6059), so the mint can never be
 * re-pointed at one a compromised authority controls while a pot is in flight.
 *
 * DRY RUN BY DEFAULT. With no argument it reports what it would do and sends nothing — which
 * is how it gets exercised against the OLD program before the upgrade, proving module
 * resolution, account derivation and instruction assembly all work with nothing at stake.
 *
 *   set -a; source .env; set +a
 *   node scripts/set-sgd-mint.mjs                 # report only
 *   node scripts/set-sgd-mint.mjs --execute       # >>> sends a transaction <<<
 */
import * as anchor from "@anchor-lang/core";
import fs from "fs";
import os from "os";

const { PublicKey, Keypair, Connection } = anchor.web3;
const RPC = process.env.HELIUS_RPC_URL;
if (!RPC) { console.error("FATAL: HELIUS_RPC_URL not set. set -a; source .env; set +a"); process.exit(1); }
const EXECUTE = process.argv.includes("--execute");
const MINT = new PublicKey(process.env.SGD_MINT ?? "4Cex8GVC5MFwPi2Uf2h2tpU16EjPyADupt9m21h7vEsR");

const conn = new Connection(RPC, "confirmed");
const authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${os.homedir()}/.config/solana/id.json`).toString())));
const idl = JSON.parse(fs.readFileSync("./target/idl/secret_garden.json").toString());
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(authority), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);

console.log(`program  : ${program.programId.toBase58()}`);
console.log(`config   : ${configPda.toBase58()}`);
console.log(`authority: ${authority.publicKey.toBase58()}`);
console.log(`$SGD mint: ${MINT.toBase58()}`);

// Prove the mint is a real, initialised SPL mint before pointing the program at it.
const mintInfo = await conn.getAccountInfo(MINT);
if (!mintInfo) { console.error("FATAL: mint account does not exist"); process.exit(1); }
console.log(`  mint owner : ${mintInfo.owner.toBase58()}`);
console.log(`  mint bytes : ${mintInfo.data.length} (SPL Mint is 82)`);
console.log(`  decimals   : ${mintInfo.data.readUInt8(44)}`);

// Assemble the instruction. This is the half that must work BEFORE the upgrade is risked:
// if `set_sgd_mint` is missing from the IDL, or the account shape is wrong, it fails here.
let ix;
try {
  ix = await program.methods.setSgdMint().accountsStrict({
    authority: authority.publicKey,
    config: configPda,
    sgdMint: MINT,
  }).instruction();
  console.log(`\ninstruction assembled OK — ${ix.keys.length} accounts, ${ix.data.length} data bytes`);
  ix.keys.forEach((k, n) => console.log(`   [${n}] ${k.pubkey.toBase58()} signer=${k.isSigner} writable=${k.isWritable}`));
} catch (e) {
  console.error(`\nINSTRUCTION ASSEMBLY FAILED: ${e.message}`);
  console.error("(expected against the OLD program — set_sgd_mint does not exist there yet)");
  if (EXECUTE) process.exit(1);
}

if (!EXECUTE) { console.log("\n[dry run — nothing sent]"); process.exit(0); }

const bh = await conn.getLatestBlockhash({ commitment: "confirmed" });
const tx = new anchor.web3.Transaction({ ...bh, feePayer: authority.publicKey }).add(ix);
tx.sign(authority);
const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
console.log(`\n  sig: ${sig}`);
const after = await program.account.gameConfig.fetch(configPda);
console.log(`  config.sgd_mint now: ${after.sgdMint.toBase58()}`);
console.log(after.sgdMint.equals(MINT) ? "  OK — pinned." : "  MISMATCH!");
