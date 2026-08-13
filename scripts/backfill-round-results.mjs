/**
 * Backfill a revealed round's results into Supabase (round_results + round_winners).
 *
 * WHEN THIS IS NEEDED. The reveal itself is on-chain and authoritative; Supabase is only the
 * mirror the frontend's Daily Winners panel reads. A round revealed WITHOUT that mirror being
 * written is invisible to players even though its winners are final on-chain — which reads as
 * a frontend bug. Historically the write lived only in operator.ts's saveResultsToSupabase, so
 * any round revealed by another route (the in-app Operator Panel) left a gap. This script
 * closes gaps after the fact.
 *
 * READ-ONLY BY DEFAULT. It prints exactly what it would insert and writes nothing unless
 * APPLY=1 is set. Chain reads go to the public devnet RPC (Helius' free tier blocks
 * getProgramAccounts, which `.all()` needs); Supabase writes use the SERVICE key, which
 * bypasses RLS, so this must only ever run server-side — never in a browser.
 *
 * IDEMPOTENT. Rows present in EITHER table abort that round, so a half-written round is never
 * "topped up" into an inconsistent state and re-running a completed backfill is a safe no-op.
 *
 * That check is now belt-and-braces rather than the only defence. Both tables were migrated on
 * 2026-08-13 to the schema in secret-garden-frontend-dev/supabase/round_results.sql:
 * `round_results` is keyed by `round_number` and `round_winners` by the composite
 * `(round_number, rank)`, with a foreign key tying a podium to its summary row. A duplicate
 * write is therefore rejected by the database (23505) rather than silently landing a second
 * podium — which is exactly what the previous surrogate `id` primary key allowed. The pre-check
 * still earns its place: it turns that conflict into a clean skip with a clear message instead
 * of a logged write error, and it inspects BOTH tables before anything is attempted.
 *
 * Rows match operator.ts's saveResultsToSupabase byte-for-byte in shape, including its
 * flowerName spelling, so a row is identical no matter which writer produced it.
 *
 * Usage — env must be EXPORTED (`set -a`), or the Supabase client is unconfigured:
 *   set -a; source .env; set +a
 *   ROUNDS=46,47 node scripts/backfill-round-results.mjs           # dry run, writes nothing
 *   APPLY=1 ROUNDS=46,47 node scripts/backfill-round-results.mjs   # actually inserts
 *
 * No key material is embedded: Supabase credentials come from the environment and the Solana
 * keypair is read from the local config path (it signs nothing — reads only).
 */
import * as anchor from '@anchor-lang/core';
import fs from 'fs'; import os from 'os';
import { createClient } from '@supabase/supabase-js';
const {PublicKey,Keypair}=anchor.web3;
const DRY = process.env.APPLY !== '1';
const pub=new anchor.web3.Connection('https://api.devnet.solana.com','confirmed');
const kp=Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(os.homedir()+'/.config/solana/id.json').toString())));
const provider=new anchor.AnchorProvider(pub,new anchor.Wallet(kp),{commitment:'confirmed'});
const program=new anchor.Program(JSON.parse(fs.readFileSync('./target/idl/secret_garden.json').toString()),provider);
const u64le=(n)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
const s=createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Mirrors operator.ts saveResultsToSupabase's flowerName EXACTLY so rows are identical
// regardless of which writer produced them.
const SPECIES_NAMES=["Sunpetal Marigold","Tideglass Bluebell","Duskwisp Lavender","Emberfern Rose","Mossheart Mint","Moonsilk Lily"];
const flowerName=(id,idx)=> id===255 ? `Hybrid #${idx}` : (SPECIES_NAMES[id] ?? `Flower #${idx}`);
/** Shown for a winner whose FlowerRecord was closed after the round — see operator.ts. */
const CLOSED_FLOWER_NAME="Retired Bloom";

const rounds=(process.env.ROUNDS||'').split(',').filter(Boolean).map(Number);
for(const n of rounds){
  const rp=PublicKey.findProgramAddressSync([Buffer.from('round'),u64le(n)],program.programId)[0];
  const round=await program.account.competitionRound.fetchNullable(rp);
  if(!round){ console.log(`round ${n}: no such round — skip`); continue; }
  if(!round.scoringRevealed){ console.log(`round ${n}: not revealed — skip`); continue; }

  // IDEMPOTENCY GUARD (same as the round-39 backfill): abort if rows already exist.
  const {data:exR}=await s.from('round_results').select('round_number').eq('round_number',n).limit(1);
  const {data:exW}=await s.from('round_winners').select('round_number').eq('round_number',n).limit(1);
  if((exR&&exR.length)||(exW&&exW.length)){ console.log(`round ${n}: rows already exist — ABORT (idempotent)`); continue; }

  const targetTraits=[...round.targetTraits].slice(0,round.targetTraitCount);
  const entries=await program.account.competitionEntry.all([{memcmp:{offset:8,bytes:rp.toBase58()}}]);
  const byEntry=new Map(entries.map(e=>[e.publicKey.toBase58(),e.account]));
  const top=[round.top1,round.top2,round.top3];
  const winnerRows=[];
  for(let i=0;i<top.length;i++){
    if(top[i].equals(PublicKey.default)) continue;
    const entry=byEntry.get(top[i].toBase58());
    if(!entry){ console.log(`  round ${n} rank ${i+1}: entry not found — skip`); continue; }
    // fetchNullable, NOT fetch: fetch() throws on a closed account, and an owner may close a
    // winning flower after the round to reclaim its rent. Backfilling a round that contains
    // one is precisely when this script is needed, so it must not die on it. Same fallback
    // operator.ts and the set-round-results edge function use, so all writers agree.
    const flower=await program.account.flowerRecord.fetchNullable(entry.flowerRecord);
    winnerRows.push({round_number:n,rank:i+1,wallet_address:entry.player.toBase58(),
      flower_name:flower?flowerName(flower.visualSpeciesId,flower.flowerIndex):CLOSED_FLOWER_NAME,
      generation:flower?flower.generation:0});
  }
  const resultRow={round_number:n,target_traits:JSON.stringify(targetTraits),
    total_entrants:round.participantCount,completed_at:new Date().toISOString()};
  console.log(`round ${n}: results=${JSON.stringify(resultRow)}`);
  winnerRows.forEach(w=>console.log(`  winner rank ${w.rank} ${w.wallet_address.slice(0,6)}… ${w.flower_name} gen ${w.generation}`));
  if(DRY){ console.log(`  [DRY RUN — nothing written]`); continue; }
  const e1=(await s.from('round_results').insert(resultRow)).error;
  const e2=winnerRows.length?(await s.from('round_winners').insert(winnerRows)).error:null;
  console.log(e1||e2 ? `  WRITE ERROR: ${(e1??e2).message}` : `  WRITTEN OK`);
}
