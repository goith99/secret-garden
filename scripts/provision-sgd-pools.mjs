/**
 * One-time operator tooling: create Orca Whirlpool "splash" pools for THIS deployment's mock
 * $SGD and seed them with liquidity, so a player can genuinely swap for the entry fee.
 *
 * Mirrors what was provisioned for the dev mint, field for field: the devnet Whirlpools config
 * `FcrweFY1…rGkR`, SPLASH tick spacing (32896) at a 1% fee, and the same two pairs —
 * wSOL/$SGD and devnet-USDC/$SGD — at the same order of magnitude of reserves.
 *
 * SPLASH pools, not concentrated: a splash pool is full-range, so the liquidity provided here
 * quotes at ANY price rather than only inside a band nobody is trading in. For a mock token
 * whose only job is to make the fee obtainable, a band that can go out of range is a footgun.
 *
 * Run from the repo root (the SDK lives in the dev frontend's node_modules — this is one-time
 * provisioning tooling, deliberately NOT a dependency of the shipped app):
 *   set -a; source .env; set +a
 *   DRY_RUN=1 node scripts/provision-sgd-pools.mjs      # quote only, sends nothing
 *   node scripts/provision-sgd-pools.mjs                # >>> SENDS TRANSACTIONS <<<
 */
import fs from "fs";
import os from "os";
import { createSolanaRpc, address, createKeyPairSignerFromBytes } from "@solana/kit";
import {
  setWhirlpoolsConfig,
  setNativeMintWrappingStrategy,
  createSplashPool,
  fetchSplashPool,
  setPayerFromBytes,
  orderMints,
  openFullRangePosition,
} from "@orca-so/whirlpools";
// The whirlpools send-callbacks delegate to @orca-so/tx-sender, which keeps its OWN rpc
// handle — `createSolanaRpc` above does not reach it, so it needs initialising separately or
// every callback throws "Connection not initialized".
import { setRpc } from "@orca-so/tx-sender";

const RPC = process.env.HELIUS_RPC_URL;
if (!RPC) { console.error("FATAL: HELIUS_RPC_URL not set. set -a; source .env; set +a"); process.exit(1); }
const DRY = process.env.DRY_RUN === "1";

const SGD  = address(process.env.SGD_MINT ?? "4Cex8GVC5MFwPi2Uf2h2tpU16EjPyADupt9m21h7vEsR");
const WSOL = address("So11111111111111111111111111111111111111112");
const USDC = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

// Mirrors dev's reserves: ~1.1 SOL + ~9267 SGD, and ~10 USDC + ~1012 SGD.
// initialPrice is quoted as tokenB per tokenA with the SDK ordering the mints canonically,
// so it is derived from the reserve ratio rather than hardcoded.
// wSOL only. The USDC pair is deliberately omitted here: the operator's devnet USDC is still
// locked in the OLD pools (closePosition fails on this SDK/splash-pool combination — see
// scripts/withdraw-old-pools.mjs), and USDC is the less useful pair anyway. A player arrives
// holding SOL, not devnet USDC, so wSOL/$SGD is the pair that actually makes the entry fee
// obtainable. Re-add the USDC pair once that liquidity is recovered.
const PAIRS = [
  { label: "wSOL/$SGD", other: WSOL, otherDecimals: 9, otherAmount: 1.1,  sgdAmount: 9267 },
];

const rpc = createSolanaRpc(RPC);
await setWhirlpoolsConfig("solanaDevnet");
await setNativeMintWrappingStrategy("ata");
await setRpc(RPC);

const secret = new Uint8Array(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf8")));
const signer = await createKeyPairSignerFromBytes(secret);
// The send-callbacks resolve their signer from module state, not the `signer` argument.
await setPayerFromBytes(secret);
console.log(`operator : ${signer.address}`);
console.log(`$SGD mint: ${SGD}`);
console.log(DRY ? "\n*** DRY RUN — nothing will be sent ***\n" : "\n*** LIVE — this sends transactions ***\n");

for (const p of PAIRS) {
  // Whirlpools require the mints in canonical (byte-sorted) order, and `initialPrice` is
  // always tokenB per tokenA IN THAT ORDER. Which side $SGD lands on differs per pair and is
  // not the same as it was for the dev mint, so it is derived rather than assumed.
  const [mintA, mintB] = orderMints(p.other, SGD);
  const sgdIsA = mintA === SGD;
  const price = sgdIsA ? p.otherAmount / p.sgdAmount : p.sgdAmount / p.otherAmount;
  // The quote is anchored on whichever side is tokenA.
  const tokenAAmount = sgdIsA
    ? BigInt(Math.round(p.sgdAmount * 10 ** 6))
    : BigInt(Math.round(p.otherAmount * 10 ** p.otherDecimals));
  console.log(`--- ${p.label} ---`);
  console.log(`  canonical order: A=${sgdIsA ? "$SGD" : p.label.split("/")[0]}  B=${sgdIsA ? p.label.split("/")[0] : "$SGD"}`);
  console.log(`  target reserves: ${p.otherAmount} + ${p.sgdAmount} $SGD  (initialPrice ${price} B per A)`);

  const existing = await fetchSplashPool(rpc, mintA, mintB).catch(() => null);
  // A pool can exist WITHOUT liquidity: creation and the first position are two separate
  // transactions, so a run that died between them leaves an initialised pool that quotes
  // nothing. Skip only the creation, never the liquidity — then re-check reserves.
  let poolAddress = existing?.initialized ? existing.address : null;
  if (poolAddress) console.log(`  already exists: ${poolAddress} — skipping creation, still seeding`);
  if (DRY) { console.log("  [dry run] would createSplashPool + seed liquidity"); continue; }

  // NOTE the argument shape: the convenience wrappers take NO rpc and NO signer — both come
  // from module state (setRpc / setPayerFromBytes above). Passing them positionally makes the
  // rpc object get parsed as a mint address, which surfaces as an opaque codec error.
  if (!poolAddress) {
    const created = await createSplashPool(mintA, mintB, price);
    const createSig = await created.callback();
    poolAddress = created.poolAddress;
    console.log(`  pool    : ${poolAddress}`);
    console.log(`  create  : ${Array.isArray(createSig) ? createSig.join(", ") : createSig}`);
  }

  // Creating the pool only fixes its price — it holds nothing until a position is opened.
  // Full-range so the quote is valid at ANY price; a concentrated band could drift out of
  // range and silently stop quoting, which for a fee token is the same as no pool at all.
  const { positionMint, callback: addLiq } = await openFullRangePosition(
    poolAddress,
    { tokenA: tokenAAmount },
    100, // 1% slippage tolerance
  );
  const liqSig = await addLiq();
  console.log(`  position: ${positionMint}`);
  console.log(`  liquidity sig: ${Array.isArray(liqSig) ? liqSig.join(", ") : liqSig}`);
}
console.log("\ndone.");
