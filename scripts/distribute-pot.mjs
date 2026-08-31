/**
 * Pays out a finalized, revealed round's $SGD pot, split equally between its winners.
 *
 * Distinct from the SOL prize pool (`COMMAND=distribute` in operator.ts) — that comes from the
 * treasury, this comes from the round's own entry fees. Both must run for a round to be fully
 * settled, and the pot must be drained before `update_sgd_mint` will let the mint move.
 *
 * Replay is guarded on chain by RoundSettlement's state — the single record of what happened to
 * a pot — so a second run fails rather than double-paying, and so does a run against a pot that
 * was refunded to its entrants instead. No heuristic needed here, unlike the SOL side.
 *
 *   set -a; source .env; set +a
 *   node scripts/distribute-pot.mjs ROUND=69            # dry run
 *   node scripts/distribute-pot.mjs ROUND=69 --execute
 */
import * as anchor from "@anchor-lang/core";
import fs from "fs"; import os from "os";
const { PublicKey, Keypair, Connection, SystemProgram } = anchor.web3;
const RPC = process.env.HELIUS_RPC_URL;
const EXECUTE = process.argv.includes("--execute");
const ROUND = Number((process.argv.find((a) => a.startsWith("ROUND=")) ?? "").split("=")[1]);
if (!Number.isInteger(ROUND)) { console.error("usage: ROUND=<n>"); process.exit(1); }

const TOK = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATOK = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ataFor = (o, m) => PublicKey.findProgramAddressSync([o.toBuffer(), TOK.toBuffer(), m.toBuffer()], ATOK)[0];
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

const conn = new Connection(RPC, "confirmed");
const authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${os.homedir()}/.config/solana/id.json`).toString())));
const idl = JSON.parse(fs.readFileSync("./target/idl/secret_garden.json").toString());
const program = new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(authority), { commitment: "confirmed" }));
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
const cfg = await program.account.gameConfig.fetch(configPda);
const [roundPda] = PublicKey.findProgramAddressSync([Buffer.from("round"), u64(ROUND)], program.programId);
const r = await program.account.competitionRound.fetch(roundPda);
const [potAuthority] = PublicKey.findProgramAddressSync([Buffer.from("pot"), u64(ROUND)], program.programId);
// ONE account answers what happened to this pot: paid, refunded, mid-refund, or nothing yet.
const [settlement] = PublicKey.findProgramAddressSync([Buffer.from("round_settlement"), u64(ROUND)], program.programId);
const SETTLEMENT_NAME = ["none", "refund in progress", "PAID to winners", "REFUNDED to entrants"];
const potVault = ataFor(potAuthority, cfg.sgdMint);

console.log(`program : ${program.programId.toBase58()}`);
console.log(`round   : ${ROUND}  status ${r.status}  revealed ${r.scoringRevealed}`);
const bal = await conn.getTokenAccountBalance(potVault).catch(() => null);
console.log(`pot     : ${bal ? bal.value.uiAmountString : "no vault"} SGD  (${potVault.toBase58()})`);
const st = await program.account.roundSettlement.fetchNullable(settlement);
if (st && st.state !== 0) {
  console.log(`settlement: ${SETTLEMENT_NAME[st.state] ?? st.state} — nothing to do.`);
  process.exit(0);
}
if (!bal || bal.value.amount === "0") { console.log("pot is empty — nothing to distribute."); process.exit(0); }

// Winners in rank order; remaining accounts are [entry, winnerAta] pairs.
const pairs = [];
for (const e of [r.top1, r.top2, r.top3]) {
  if (e.equals(PublicKey.default)) continue;
  const entry = await program.account.competitionEntry.fetch(e);
  pairs.push({ entry: e, player: entry.player, ata: ataFor(entry.player, cfg.sgdMint) });
}
console.log(`winners : ${pairs.length}`);
pairs.forEach((p, i) => console.log(`  rank ${i + 1}: ${p.player.toBase58()}  ata ${p.ata.toBase58().slice(0, 12)}…`));
if (!EXECUTE) { console.log("\n[dry run — nothing sent]"); process.exit(0); }

// Every winner needs a $SGD account to receive into; create any that are missing.
for (const p of pairs) {
  if (await conn.getAccountInfo(p.ata)) continue;
  const ix = new anchor.web3.TransactionInstruction({
    programId: ATOK,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: p.ata, isSigner: false, isWritable: true },
      { pubkey: p.player, isSigner: false, isWritable: false },
      { pubkey: cfg.sgdMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOK, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([]),
  });
  const bh = await conn.getLatestBlockhash("confirmed");
  const tx = new anchor.web3.Transaction({ ...bh, feePayer: authority.publicKey }).add(ix);
  tx.sign(authority);
  const s = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction({ signature: s, ...bh }, "confirmed");
  console.log(`  created ATA for ${p.player.toBase58().slice(0, 10)}… ${s.slice(0, 16)}…`);
}

const tx = await program.methods.distributePot().accountsStrict({
  authority: authority.publicKey, config: configPda, round: roundPda,
  settlement, potAuthority, potVault, sgdMint: cfg.sgdMint,
  tokenProgram: TOK, systemProgram: SystemProgram.programId,
}).remainingAccounts(pairs.flatMap((p) => ([
  { pubkey: p.entry, isSigner: false, isWritable: false },
  { pubkey: p.ata, isSigner: false, isWritable: true },
]))).transaction();
const bh = await conn.getLatestBlockhash("confirmed");
tx.recentBlockhash = bh.blockhash; tx.feePayer = authority.publicKey; tx.sign(authority);
const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
console.log(`\ndistribute_pot sig: ${sig}`);
const after = await conn.getTokenAccountBalance(potVault);
console.log(`pot after: ${after.value.uiAmountString} SGD`);
