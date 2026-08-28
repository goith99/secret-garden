/**
 * Closes this operator's Orca positions in the OLD $SGD pools and returns the liquidity.
 *
 * Run when a $SGD mint is retired. The pools themselves cannot be deleted — a Whirlpool is a
 * permanent on-chain account — but the liquidity in them is ours and there is no reason to
 * abandon it. What is left behind is an empty pool nobody can trade against, which is inert.
 *
 * Closing a position also sweeps its accrued fees, so this is strictly better than walking away.
 *
 *   set -a; source .env; set +a
 *   node scripts/withdraw-old-pools.mjs                 # list positions, send nothing
 *   node scripts/withdraw-old-pools.mjs --execute
 */
import fs from "fs"; import os from "os";
import { createSolanaRpc, address, createKeyPairSignerFromBytes } from "@solana/kit";
import { setWhirlpoolsConfig, setPayerFromBytes, setNativeMintWrappingStrategy,
         fetchPositionsForOwner, closePosition } from "@orca-so/whirlpools";
import { setRpc } from "@orca-so/tx-sender";

const RPC = process.env.HELIUS_RPC_URL;
const EXECUTE = process.argv.includes("--execute");
// Retired mints whose pools should be emptied. Both environments' old mints are listed because
// the operator wallet is the liquidity provider on both.
const OLD_MINTS = new Set([
  "7TQniotr7p1PjKmasp4g3tGpyx1meFvdrzEu8Rz4waEB", // dev's first $SGD
  "4Cex8GVC5MFwPi2Uf2h2tpU16EjPyADupt9m21h7vEsR", // production's first $SGD
]);

const rpc = createSolanaRpc(RPC);
await setWhirlpoolsConfig("solanaDevnet");
await setNativeMintWrappingStrategy("ata");
await setRpc(RPC);
const secret = new Uint8Array(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`).toString()));
await setPayerFromBytes(secret);
const signer = await createKeyPairSignerFromBytes(secret);
console.log(`operator: ${signer.address}\n`);

const positions = await fetchPositionsForOwner(rpc, signer.address);
console.log(`positions owned: ${positions.length}`);
let closed = 0;
for (const p of positions) {
  const pool = p.data?.whirlpool;
  if (!pool) continue;
  // Only touch positions in pools that hold a retired mint.
  const wp = await rpc.getAccountInfo(pool, { encoding: "base64" }).send();
  if (!wp.value) continue;
  const raw = Buffer.from(wp.value.data[0], "base64");
  const mintA = raw.subarray(101, 133), mintB = raw.subarray(181, 213);
  const { getAddressEncoder } = await import("@solana/kit");
  const b58 = (buf) => address(require_bs58(buf));
  function require_bs58(buf) {
    const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n = 0n; for (const b of buf) n = n * 256n + BigInt(b);
    let s = ""; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
    for (const b of buf) { if (b === 0) s = "1" + s; else break; }
    return s;
  }
  const a58 = require_bs58(mintA), b58s = require_bs58(mintB);
  if (!OLD_MINTS.has(a58) && !OLD_MINTS.has(b58s)) continue;
  console.log(`  position ${p.address} in pool ${pool}`);
  console.log(`    pair ${a58.slice(0, 8)}… / ${b58s.slice(0, 8)}…`);
  if (!EXECUTE) { console.log("    [dry run] would close"); continue; }
  const { callback } = await closePosition(p.address, 100);
  const sig = await callback();
  console.log(`    closed: ${Array.isArray(sig) ? sig.join(", ") : sig}`);
  closed++;
}
console.log(`\n${EXECUTE ? `closed ${closed}` : "dry run"} — done.`);
