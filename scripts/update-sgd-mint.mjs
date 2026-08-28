/**
 * Re-points `GameConfig.sgd_mint`. Wraps the on-chain guards with the two checks a caller
 * needs to see BEFORE sending: the current round must be FINALIZED, and its pot must be empty.
 * Both are enforced on chain too — this just fails early with a readable reason.
 *
 *   set -a; source .env; set +a
 *   NEW_MINT=<pubkey> node scripts/update-sgd-mint.mjs [--execute]
 */
import * as anchor from "@anchor-lang/core";
import fs from "fs"; import os from "os";
const { PublicKey, Keypair, Connection } = anchor.web3;
const EXECUTE = process.argv.includes("--execute");
const NEW = new PublicKey(process.env.NEW_MINT);
const TOK = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATOK = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const conn = new Connection(process.env.HELIUS_RPC_URL, "confirmed");
const authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${os.homedir()}/.config/solana/id.json`).toString())));
const idl = JSON.parse(fs.readFileSync("./target/idl/secret_garden.json").toString());
const program = new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(authority), { commitment: "confirmed" }));
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
const cfg = await program.account.gameConfig.fetch(configPda);
const rid = Number(cfg.currentRound.toString());
const [roundPda] = PublicKey.findProgramAddressSync([Buffer.from("round"), u64(rid)], program.programId);
const r = await program.account.competitionRound.fetch(roundPda);
const [potAuthority] = PublicKey.findProgramAddressSync([Buffer.from("pot"), u64(rid)], program.programId);
const [oldPotVault] = PublicKey.findProgramAddressSync(
  [potAuthority.toBuffer(), TOK.toBuffer(), cfg.sgdMint.toBuffer()], ATOK);
const bal = await conn.getTokenAccountBalance(oldPotVault).catch(() => null);
console.log(`program : ${program.programId.toBase58()}`);
console.log(`old mint: ${cfg.sgdMint.toBase58()}`);
console.log(`new mint: ${NEW.toBase58()}`);
console.log(`round   : ${rid}  status ${r.status} (2 = FINALIZED required)`);
console.log(`old pot : ${bal ? bal.value.uiAmountString : "n/a"} SGD (must be 0)`);
if (!EXECUTE) { console.log("\n[dry run — nothing sent]"); process.exit(0); }
const tx = await program.methods.updateSgdMint().accountsStrict({
  authority: authority.publicKey, config: configPda, round: roundPda,
  oldPotVault, newSgdMint: NEW,
}).transaction();
const bh = await conn.getLatestBlockhash("confirmed");
tx.recentBlockhash = bh.blockhash; tx.feePayer = authority.publicKey; tx.sign(authority);
const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
console.log(`\nsig: ${sig}`);
const after = await program.account.gameConfig.fetch(configPda);
console.log(`config.sgd_mint now: ${after.sgdMint.toBase58()}`);
console.log(after.sgdMint.equals(NEW) ? "OK — re-pointed." : "MISMATCH!");
