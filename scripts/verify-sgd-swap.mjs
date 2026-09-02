/**
 * Proves a PLAYER can obtain $SGD: funds a throwaway wallet with SOL and swaps it for $SGD
 * through the production Orca pool. If this fails, the entry fee is unobtainable and the
 * competition half of the game is shut, so it is worth proving as a player rather than
 * assuming from the pool's reserves.
 *
 *   set -a; source .env; set +a
 *   node scripts/verify-sgd-swap.mjs          (run from a tree with @orca-so/whirlpools)
 */
import fs from "fs"; import os from "os";
import { createSolanaRpc, address, createKeyPairSignerFromBytes } from "@solana/kit";
import { setWhirlpoolsConfig, setNativeMintWrappingStrategy, setPayerFromBytes, swap, fetchSplashPool } from "@orca-so/whirlpools";
import { setRpc } from "@orca-so/tx-sender";
import { Connection, PublicKey, Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";

const RPC = process.env.HELIUS_RPC_URL;
const SGD = address(process.env.SGD_MINT ?? "4Cex8GVC5MFwPi2Uf2h2tpU16EjPyADupt9m21h7vEsR");
const WSOL = address("So11111111111111111111111111111111111111112");

const conn = new Connection(RPC, "confirmed");
const op = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`).toString())));
const player = Keypair.generate();
console.log(`throwaway player: ${player.publicKey.toBase58()}`);

// Fund it — a real player arrives with SOL and nothing else.
const bh = await conn.getLatestBlockhash("confirmed");
const fund = new Transaction({ ...bh, feePayer: op.publicKey }).add(
  SystemProgram.transfer({ fromPubkey: op.publicKey, toPubkey: player.publicKey, lamports: 0.25 * LAMPORTS_PER_SOL }));
fund.sign(op);
const fsig = await conn.sendRawTransaction(fund.serialize());
await conn.confirmTransaction({ signature: fsig, ...bh }, "confirmed");
console.log(`funded 0.25 SOL: ${fsig}`);

const rpc = createSolanaRpc(RPC);
await setWhirlpoolsConfig("solanaDevnet");
await setNativeMintWrappingStrategy("ata");
await setRpc(RPC);
await setPayerFromBytes(player.secretKey);
const signer = await createKeyPairSignerFromBytes(player.secretKey);

const pool = await fetchSplashPool(rpc, WSOL, SGD);
console.log(`pool: ${pool.address}  initialized=${pool.initialized}`);

// Swap 0.05 SOL -> $SGD by default. At ~8425 SGD/SOL that is ~420 SGD, comfortably over the
// 100 fee. SWAP_LAMPORTS overrides the amount, the same env-or-default shape SGD_MINT uses
// above — the figures in this comment describe the default, not whatever is passed in.
const IN = BigInt(process.env.SWAP_LAMPORTS ?? 50_000_000);
const { quote, callback } = await swap({ inputAmount: IN, mint: WSOL }, pool.address, signer);
console.log(`quote: ${Number(IN) / 1e9} SOL -> ~${Number(quote.tokenEstOut) / 1e6} $SGD (min ${Number(quote.tokenMinOut) / 1e6})`);
const sig = await callback();
console.log(`swap sig: ${Array.isArray(sig) ? sig.join(", ") : sig}`);

const ata = PublicKey.findProgramAddressSync(
  [player.publicKey.toBuffer(), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBuffer(), new PublicKey(SGD).toBuffer()],
  new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"))[0];
const bal = await conn.getTokenAccountBalance(ata);
console.log(`\nplayer $SGD balance: ${bal.value.uiAmountString}`);
console.log(bal.value.uiAmount >= 100 ? "PASS — player can afford the 100 $SGD entry fee" : "FAIL — under the fee");
fs.writeFileSync("/tmp/claude-1000/-home-goith-goithprojects/83f674df-cf3b-4879-964a-f27dc1842003/scratchpad/player.json", JSON.stringify(Array.from(player.secretKey)));
