/**
 * Reclaims the rent under settled rounds' $SGD pot vaults, and creates the one account that
 * makes doing so possible at all.
 *
 * # Why this exists
 *
 * `open_round` creates a round's pot vault with `init_if_needed`, paid by the operator, so every
 * round costs the operator one rent-exempt token account (0.00148844 SOL on devnet). That rent
 * comes back through `close_pot_vault` once the round is settled — except nothing has ever called
 * `close_pot_vault`. It appears in two other scripts only inside log strings telling the reader to
 * run it, and there was no `run it` to reach: the instruction pins `surplus_destination` to
 * `config.authority`'s $SGD associated token account, and that account did not exist. It is a
 * plain `Account<TokenAccount>`, not `init_if_needed`, so every call failed at account resolution
 * before the handler ran. The account stopped existing the moment the authority moved behind the
 * Squads vault, because a vault PDA starts with no token accounts and nothing here ever made one.
 *
 * So this script does both halves: it creates that ATA if missing (a permissionless ATA-program
 * call — the vault does not have to sign to receive an account), then closes every vault whose
 * round has reached a terminal settlement.
 *
 * # Who signs
 *
 * `close_pot_vault` takes `is_operator_or_authority`, so a REGISTERED OPERATOR is enough and no
 * Squads flow is involved. That matters for automation: this can run unattended in the daily
 * cycle. Only `refund_unrevealed_pot` is authority-only, and this script never touches it.
 *
 * The reclaimed rent goes to the signer, which is correct and deliberate: the operator paid the
 * rent in `open_round`, so the operator gets it back. The unclaimed $SGD surplus goes somewhere
 * the caller cannot influence — `config.authority`'s ATA — which is why that account is required
 * even when, as today, every surplus is zero.
 *
 * # What it will not close
 *
 * A round that TOOK ENTRIES and has not been settled. Those have real fees in their history and
 * must go through `distribute_pot` or `refund_unrevealed_pot` first; the program rejects them
 * with `RoundHadEntrants` (6080).
 *
 * A round that finalized with NO entrants is a different case and IS closable. It can never
 * reach a settlement — nothing to score, so never revealed, so `distribute_pot` refuses it
 * forever — and with `participant_count == 0` there were never any entrant funds to account for,
 * so the close only reclaims the operator's own rent.
 *
 *   set -a; source .env; set +a
 *   export OPERATOR_KEYPAIR=~/.config/solana/railway-operator-mine.json
 *   node scripts/close-pot-vaults.mjs                    # dry run, every round
 *   node scripts/close-pot-vaults.mjs --execute          # sweep every closable vault
 *   node scripts/close-pot-vaults.mjs ROUND=70 --execute # one round (used by auto-cycle)
 */
import * as anchor from "@anchor-lang/core";
import fs from "fs"; import os from "os";
const { PublicKey, Keypair, Connection, SystemProgram } = anchor.web3;

const RPC = process.env.HELIUS_RPC_URL;
if (!RPC) { console.error("HELIUS_RPC_URL is required"); process.exit(1); }
const EXECUTE = process.argv.includes("--execute");
const ONE = (process.argv.find((a) => a.startsWith("ROUND=")) ?? "").split("=")[1];
const ONLY_ROUND = ONE === undefined ? null : Number(ONE);
if (ONLY_ROUND !== null && !Number.isInteger(ONLY_ROUND)) { console.error("ROUND= must be an integer"); process.exit(1); }

const TOK = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATOK = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ataFor = (o, m) => PublicKey.findProgramAddressSync([o.toBuffer(), TOK.toBuffer(), m.toBuffer()], ATOK)[0];
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const SOL = (l) => `${(l / 1e9).toFixed(9)} SOL`;

// Mirrors SETTLEMENT_* in constants.rs. Only PAID and REFUNDED are terminal — the states
// `close_pot_vault` will accept.
const SETTLEMENT_NAME = ["none", "refund in progress", "PAID to winners", "REFUNDED to entrants"];
const TERMINAL = new Set([2, 3]);
const ROUND_STATUS_FINALIZED = 2;

const conn = new Connection(RPC, "confirmed");
const signer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(process.env.OPERATOR_KEYPAIR ?? `${os.homedir()}/.config/solana/id.json`).toString())));
const idl = JSON.parse(fs.readFileSync("./target/idl/secret_garden.json").toString());
const program = new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(signer), { commitment: "confirmed" }));

const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
const cfg = await program.account.gameConfig.fetch(configPda);
const isOperator = cfg.authority.equals(signer.publicKey)
  || cfg.operators.slice(0, cfg.operatorCount).some((o) => o.equals(signer.publicKey));

console.log(`program   : ${program.programId.toBase58()}`);
console.log(`signer    : ${signer.publicKey.toBase58()}  ${isOperator ? "(operator or authority — ok)" : "*** NOT AUTHORISED ***"}`);
console.log(`authority : ${cfg.authority.toBase58()}`);
console.log(`sgd mint  : ${cfg.sgdMint.toBase58()}`);
if (!isOperator) {
  console.error("\nThis signer is neither the authority nor a registered operator; close_pot_vault would reject it.");
  console.error("Set OPERATOR_KEYPAIR to a registered operator's keypair.");
  process.exit(1);
}

// --- the account whose absence made close_pot_vault uncallable -----------------------------
const surplusDestination = ataFor(cfg.authority, cfg.sgdMint);
const surplusExists = await conn.getAccountInfo(surplusDestination);
console.log(`surplus → : ${surplusDestination.toBase58()}  ${surplusExists ? "exists" : "MISSING — must be created first"}`);

// --- survey ---------------------------------------------------------------------------------
const last = ONLY_ROUND ?? Number(cfg.currentRound);
const first = ONLY_ROUND ?? 1;
const closable = [], blocked = [];
for (let r = first; r <= last; r++) {
  const [roundPda] = PublicKey.findProgramAddressSync([Buffer.from("round"), u64(r)], program.programId);
  const round = await program.account.competitionRound.fetchNullable(roundPda);
  if (!round) continue;
  const [potAuthority] = PublicKey.findProgramAddressSync([Buffer.from("pot"), u64(r)], program.programId);
  const potVault = ataFor(potAuthority, cfg.sgdMint);
  const vaultInfo = await conn.getAccountInfo(potVault);
  if (!vaultInfo) continue; // already closed, or never opened under this mint
  const [settlement] = PublicKey.findProgramAddressSync([Buffer.from("round_settlement"), u64(r)], program.programId);
  const st = await program.account.roundSettlement.fetchNullable(settlement);
  const amount = Number(vaultInfo.data.readBigUInt64LE(64));
  const common = { r, roundPda, potAuthority, potVault, settlement, rent: vaultInfo.lamports, amount };

  if (!st) {
    // The empty-round path. `close_pot_vault` accepts a FINALIZED round with no entrants and no
    // settlement, because such a round can never reach one: nothing to score, so never revealed,
    // so `distribute_pot` refuses it forever. Anything else without a settlement stays blocked.
    if (round.status === ROUND_STATUS_FINALIZED && round.participantCount === 0) {
      closable.push({ ...common, state: null });
    } else {
      blocked.push({ ...common, why: round.participantCount > 0
        ? `no RoundSettlement, and the round took ${round.participantCount} entr${round.participantCount === 1 ? "y" : "ies"} — it must be distributed or refunded first`
        : `no RoundSettlement, and the round is not FINALIZED yet (status ${round.status})` });
    }
  } else if (Number(st.roundId) !== r) {
    blocked.push({ ...common, why: `settlement belongs to round ${st.roundId}` });
  } else if (!TERMINAL.has(st.state)) {
    blocked.push({ ...common, why: `settlement is ${SETTLEMENT_NAME[st.state] ?? st.state}` });
  } else {
    closable.push({ ...common, state: st.state });
  }
}

const fmt = (x) => `  round ${String(x.r).padStart(3)}  rent ${String(x.rent).padStart(8)} (${SOL(x.rent)})  holds ${x.amount} base units`;
console.log(`\nCLOSABLE (${closable.length}):`);
closable.forEach((x) => console.log(`${fmt(x)}  — ${
  x.state === null ? "no entrants, never settled (empty round)" : SETTLEMENT_NAME[x.state]}`));
console.log(`BLOCKED  (${blocked.length}):`);
blocked.forEach((x) => console.log(`${fmt(x)}\n        ${x.why}`));

const recoverable = closable.reduce((s, x) => s + x.rent, 0);
const stranded = blocked.reduce((s, x) => s + x.rent, 0);
console.log(`\nrecoverable now : ${recoverable} lamports (${SOL(recoverable)})`);
console.log(`stranded        : ${stranded} lamports (${SOL(stranded)}) across ${blocked.length} vault(s)`);

if (!closable.length && surplusExists) { console.log("\nnothing to do."); process.exit(0); }
if (!EXECUTE) { console.log("\n[dry run — nothing sent; re-run with --execute]"); process.exit(0); }

const send = async (tx, label) => {
  const bh = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = bh.blockhash; tx.feePayer = signer.publicKey; tx.sign(signer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  console.log(`  ${label}  ${sig}`);
  return sig;
};

// --- create the surplus destination, once ---------------------------------------------------
// A plain ATA-program create. The owner is the Squads vault PDA and does not sign: an associated
// token account is derived, so anyone may pay to bring one into existence for anybody.
if (!surplusExists) {
  console.log(`\ncreating surplus destination for ${cfg.authority.toBase58()}…`);
  await send(new anchor.web3.Transaction().add(new anchor.web3.TransactionInstruction({
    programId: ATOK,
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: surplusDestination, isSigner: false, isWritable: true },
      { pubkey: cfg.authority, isSigner: false, isWritable: false },
      { pubkey: cfg.sgdMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOK, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([]),
  })), "created ATA");
}

// --- close ----------------------------------------------------------------------------------
let reclaimed = 0, failed = 0;
const before = await conn.getBalance(signer.publicKey);
for (const x of closable) {
  process.stdout.write(`\nround ${x.r}: closing ${x.potVault.toBase58().slice(0, 12)}…\n`);
  try {
    const tx = await program.methods.closePotVault().accountsStrict({
      authority: signer.publicKey, config: configPda, round: x.roundPda, settlement: x.settlement,
      potAuthority: x.potAuthority, potVault: x.potVault, sgdMint: cfg.sgdMint,
      surplusDestination, tokenProgram: TOK,
    }).transaction();
    await send(tx, `closed, +${SOL(x.rent)}`);
    reclaimed += x.rent;
  } catch (e) {
    failed++;
    console.log(`  FAILED: ${e.message?.split("\n")[0] ?? e}`);
  }
}
const after = await conn.getBalance(signer.publicKey);
console.log(`\nclosed ${closable.length - failed}/${closable.length} vault(s), ${failed} failed`);
console.log(`rent reclaimed  : ${reclaimed} lamports (${SOL(reclaimed)})`);
console.log(`signer balance  : ${SOL(before)} → ${SOL(after)}  (net ${SOL(after - before)}, after tx fees)`);
