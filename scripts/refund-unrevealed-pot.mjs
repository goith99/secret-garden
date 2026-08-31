/**
 * Hands an UNREVEALED finalized round's $SGD pot back to the players who paid into it.
 *
 * The counterpart to distribute-pot.mjs, for the rounds that one can never help. A round that
 * was finalized without ever being revealed has no winners, so `distribute_pot` refuses it
 * forever — and before `refund_unrevealed_pot` existed there was no other way to move that
 * vault, so the entry fees were simply lost. Several devnet rounds are already in that state.
 *
 * The on-chain rules this obeys, so surprises here are the program's and not this script's:
 *   - the round must be FINALIZED and NOT revealed, and not already settled either way,
 *   - at least POT_REFUND_MIN_AGE_SECONDS (7 days) past its submission deadline,
 *   - entries must arrive in strictly ascending pubkey order, across ALL batches.
 *
 * The ordering is why this script exists rather than a one-liner: entrants are paid a few at a
 * time (an account list cannot hold 52 entries plus their token accounts), and the program's
 * cursor rejects anything out of order, so the batching and the sort have to agree with it.
 * Re-running is safe and is the intended way to resume — already-paid entrants are skipped
 * because the cursor has moved past them.
 *
 *   set -a; source .env; set +a
 *   node scripts/refund-unrevealed-pot.mjs ROUND=53             # dry run
 *   node scripts/refund-unrevealed-pot.mjs ROUND=53 --execute
 */
import * as anchor from "@anchor-lang/core";
import fs from "fs"; import os from "os";
const { PublicKey, Keypair, Connection, SystemProgram } = anchor.web3;
const RPC = process.env.HELIUS_RPC_URL;
const EXECUTE = process.argv.includes("--execute");
const ROUND = Number((process.argv.find((a) => a.startsWith("ROUND=")) ?? "").split("=")[1]);
if (!Number.isInteger(ROUND)) { console.error("usage: ROUND=<n> [--execute]"); process.exit(1); }

/** Entrants per transaction. 11 fixed accounts + 2 per entrant fits a legacy transaction. */
const BATCH = 8;

const TOK = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATOK = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ataFor = (o, m) => PublicKey.findProgramAddressSync([o.toBuffer(), TOK.toBuffer(), m.toBuffer()], ATOK)[0];
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const pda = (seed) => PublicKey.findProgramAddressSync([Buffer.from(seed), u64(ROUND)], program.programId)[0];

const conn = new Connection(RPC, "confirmed");
const authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${os.homedir()}/.config/solana/id.json`).toString())));
const idl = JSON.parse(fs.readFileSync("./target/idl/secret_garden.json").toString());
const program = new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(authority), { commitment: "confirmed" }));

const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
const cfg = await program.account.gameConfig.fetch(configPda);
const roundPda = pda("round");
const r = await program.account.competitionRound.fetch(roundPda);
const potAuthority = pda("pot"), settlement = pda("round_settlement");
const potVault = ataFor(potAuthority, cfg.sgdMint);

const GRACE = 7 * 86400;
const now = Math.floor(Date.now() / 1000);
const eligibleAt = Number(r.endTime) + GRACE;

console.log(`program : ${program.programId.toBase58()}`);
console.log(`round   : ${ROUND}  status ${r.status}  revealed ${r.scoringRevealed}  entrants ${r.participantCount}`);
const bal = await conn.getTokenAccountBalance(potVault).catch(() => null);
console.log(`pot     : ${bal ? bal.value.uiAmountString : "no vault"} SGD  (${potVault.toBase58()})`);
console.log(`eligible: ${new Date(eligibleAt * 1000).toISOString()}  (${now >= eligibleAt ? "YES" : "not yet"})`);

if (r.status !== 2) { console.log("round is not FINALIZED — refund refuses it."); process.exit(1); }
if (r.scoringRevealed) { console.log("round IS revealed — use distribute-pot.mjs, not this."); process.exit(1); }
const st0 = await program.account.roundSettlement.fetchNullable(settlement);
if (st0 && st0.state === 2) { console.log("pot was already DISTRIBUTED to winners — nothing to refund."); process.exit(0); }
if (now < eligibleAt) { console.log("grace period has not elapsed — refund would be refused on-chain."); process.exit(1); }

// Resume position, if a previous run got partway.
let marker = st0;
if (marker && marker.state === 3) {
  console.log(`ALREADY REFUNDED in full: ${marker.recipientCount}/${marker.entrantCount} entrants, ` +
    `${Number(marker.totalSettled) / 1e6} SGD (surplus ${Number(marker.surplus) / 1e6} SGD left for close).`);
  process.exit(0);
}

// Every entry of this round, sorted the way the on-chain cursor requires: BYTE-WISE ascending
// on the entry pubkey. Not base58 — base58 orders differently, and the mismatch would only bite
// on roughly one key in 256, which is exactly the kind of bug that looks intermittent.
const all = await program.account.competitionEntry.all([
  { memcmp: { offset: 8, bytes: roundPda.toBase58() } },
]);
const rows = all
  .map((e) => ({ entry: e.publicKey, player: e.account.player, ata: ataFor(e.account.player, cfg.sgdMint) }))
  .sort((a, b) => Buffer.compare(a.entry.toBuffer(), b.entry.toBuffer()));

if (rows.length !== r.participantCount) {
  console.log(`\nREFUSING: found ${rows.length} entries but participant_count is ${r.participantCount}.`);
  console.log(`The refund can only complete when every entrant is paid, so a short list would`);
  console.log(`strand the vault half-drained. Investigate before running with --execute.`);
  process.exit(1);
}

const done = marker ? Number(marker.recipientCount) : 0;
const pending = rows.slice(done);
// A FLAT per-head figure, not a share of the vault: each entrant gets back exactly what they
// paid. Anything above the sum of fees is surplus that belongs to nobody and stays put.
const FEE = 100_000_000;
const potNow = Number(bal?.value.amount ?? 0);
const per = marker && Number(marker.perEntrant) ? Number(marker.perEntrant)
  : Math.min(FEE, Math.floor(potNow / Math.max(rows.length, 1)));
const surplus = marker && marker.state !== 0 ? Number(marker.surplus) : potNow - per * rows.length;
console.log(`entrants: ${rows.length} total, ${done} already refunded, ${pending.length} pending`);
console.log(`each    : ${per / 1e6} SGD (flat — everyone gets back what they paid)`);
console.log(`surplus : ${surplus / 1e6} SGD unclaimed, stays in the vault for close_pot_vault to sweep`);
if (!EXECUTE) { console.log(`\n[dry run — ${Math.ceil(pending.length / BATCH)} batch(es) would be sent]`); process.exit(0); }

// A refund can only complete if every entrant has somewhere to receive into.
for (const p of pending) {
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

for (let i = 0; i < pending.length; i += BATCH) {
  const slice = pending.slice(i, i + BATCH);
  const tx = await program.methods.refundUnrevealedPot().accountsStrict({
    authority: authority.publicKey, config: configPda, round: roundPda,
    settlement, potAuthority, potVault, sgdMint: cfg.sgdMint,
    tokenProgram: TOK, associatedTokenProgram: ATOK, systemProgram: SystemProgram.programId,
  }).remainingAccounts(slice.flatMap((p) => ([
    { pubkey: p.entry, isSigner: false, isWritable: false },
    { pubkey: p.ata, isSigner: false, isWritable: true },
  ]))).transaction();
  const bh = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = bh.blockhash; tx.feePayer = authority.publicKey; tx.sign(authority);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  console.log(`batch ${i / BATCH + 1}: refunded ${slice.length} entrant(s)  sig ${sig.slice(0, 20)}…`);
}

marker = await program.account.roundSettlement.fetch(settlement);
const after = await conn.getTokenAccountBalance(potVault);
console.log(`\nrefunded : ${marker.recipientCount}/${marker.entrantCount} entrants, ` +
  `${Number(marker.totalSettled) / 1e6} SGD`);
console.log(`complete : ${marker.state === 3}`);
console.log(`pot after: ${after.value.uiAmountString} SGD` +
  (marker.state === 3 ? ` (unclaimed surplus — run close_pot_vault to sweep it to the authority)` : ""));
