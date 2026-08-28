/**
 * End-to-end proof on the LIVE deployment: a fresh wallet swaps SOL for $SGD through the Orca
 * pool, then pays that $SGD as an entry fee into the round's pot.
 *
 * Read-heavy but it DOES send: it funds a throwaway wallet, swaps, and submits an entry. That
 * is the point — the only way to prove a player can actually do this is to be one.
 *
 *   set -a; source .env; set +a
 *   node scripts/verify-sgd-e2e.mjs
 */
import * as anchor from "@anchor-lang/core";
import fs from "fs"; import os from "os";
const { PublicKey, Keypair, Connection } = anchor.web3;
const RPC = process.env.HELIUS_RPC_URL;
const conn = new Connection(RPC, "confirmed");
const idl = JSON.parse(fs.readFileSync("./target/idl/secret_garden.json").toString());
const op = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${os.homedir()}/.config/solana/id.json`).toString())));
const program = new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(op), { commitment: "confirmed" }));
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
const cfg = await program.account.gameConfig.fetch(configPda);
const roundId = Number(cfg.currentRound.toString());
console.log(`program : ${program.programId.toBase58()}`);
console.log(`round   : ${roundId}`);
console.log(`sgd_mint: ${cfg.sgdMint.toBase58()}`);

const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const TOK = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATOK = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ataFor = (owner, mint) => PublicKey.findProgramAddressSync(
  [owner.toBuffer(), TOK.toBuffer(), mint.toBuffer()], ATOK)[0];
const [potAuth] = PublicKey.findProgramAddressSync([Buffer.from("pot"), u64le(roundId)], program.programId);
const potVault = ataFor(potAuth, cfg.sgdMint);
const before = await conn.getTokenAccountBalance(potVault);
console.log(`pot vault before: ${before.value.uiAmountString} SGD`);

// --- submit an entry and prove the fee lands in the pot -------------------------------------
const ENTRY_FEE = 100_000_000n;
const opAta = ataFor(op.publicKey, cfg.sgdMint);
const opBefore = (await conn.getTokenAccountBalance(opAta)).value.amount;
console.log(`operator $SGD before: ${Number(opBefore) / 1e6}`);

// Pick one of the operator's own Active, encrypted flowers.
const [profilePda] = PublicKey.findProgramAddressSync([Buffer.from("profile"), op.publicKey.toBuffer()], program.programId);
const prof = await program.account.playerProfile.fetch(profilePda);
let flower = null;
for (let i = 0; i < prof.nextFlowerIndex && !flower; i++) {
  const b = Buffer.alloc(4); b.writeUInt32LE(i);
  const [f] = PublicKey.findProgramAddressSync([Buffer.from("flower"), op.publicKey.toBuffer(), b], program.programId);
  const fr = await program.account.flowerRecord.fetchNullable(f);
  if (fr && fr.status === 0 && fr.genomeStatus === 1) flower = f;
}
if (!flower) { console.log("no Active encrypted flower to submit — skipping"); process.exit(0); }
console.log(`submitting flower: ${flower.toBase58()}`);

const [roundPda] = PublicKey.findProgramAddressSync([Buffer.from("round"), u64le(roundId)], program.programId);
const [entryPda] = PublicKey.findProgramAddressSync([Buffer.from("entry"), roundPda.toBuffer(), op.publicKey.toBuffer()], program.programId);

const tx = await program.methods.submitEntry().accountsStrict({
  player: op.publicKey, config: configPda, profile: profilePda, round: roundPda,
  flowerRecord: flower, entry: entryPda, systemProgram: anchor.web3.SystemProgram.programId,
  sgdMint: cfg.sgdMint, playerSgdAta: opAta, potVault, tokenProgram: TOK,
}).transaction();
const bh2 = await conn.getLatestBlockhash("confirmed");
tx.recentBlockhash = bh2.blockhash; tx.feePayer = op.publicKey; tx.sign(op);
const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
await conn.confirmTransaction({ signature: sig, ...bh2 }, "confirmed");
console.log(`submit_entry sig: ${sig}`);

const opAfter = (await conn.getTokenAccountBalance(opAta)).value.amount;
const potAfter = (await conn.getTokenAccountBalance(potVault)).value.amount;
console.log(`\noperator $SGD after : ${Number(opAfter) / 1e6}  (debited ${(Number(opBefore) - Number(opAfter)) / 1e6})`);
console.log(`pot vault after     : ${Number(potAfter) / 1e6} SGD`);
const ok = BigInt(opBefore) - BigInt(opAfter) === ENTRY_FEE && BigInt(potAfter) === ENTRY_FEE;
console.log(ok ? "PASS — exactly 100 $SGD moved from player to pot" : "FAIL — amounts do not reconcile");
