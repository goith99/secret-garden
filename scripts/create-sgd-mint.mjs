/**
 * Creates a $SGD mint in the ONLY order that works: mint -> METADATA -> supply -> renounce.
 *
 * The order is not stylistic. Metaplex `CreateMetadataAccountV3` takes the MINT AUTHORITY as a
 * required signer and checks it against the mint's on-chain authority. Renounce first and the
 * check can never be satisfied by anybody — simulating it returns 0xa, "Mint authority provided
 * does not match the authority on the mint" — so the token is permanently nameless and every
 * DEX renders it as a truncated address. That is exactly how the first two $SGD mints ended up
 * unfixable, and it is why this script exists instead of a sequence of shell commands.
 *
 *   set -a; source .env; set +a
 *   node scripts/create-sgd-mint.mjs --execute
 */
import * as anchor from "@anchor-lang/core";
import fs from "fs"; import os from "os";
const { PublicKey, Keypair, Connection, SystemProgram, Transaction, TransactionInstruction } = anchor.web3;
const RPC = process.env.HELIUS_RPC_URL;
const EXECUTE = process.argv.includes("--execute");
const NAME = "Secret Garden Dollar", SYMBOL = "SGD", URI = "";
const DECIMALS = 6, SUPPLY = 500_000;

const MPL = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const TOK = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATOK = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${os.homedir()}/.config/solana/id.json`).toString())));
const send = async (ixs, signers, label) => {
  const bh = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ ...bh, feePayer: payer.publicKey }).add(...ixs);
  tx.sign(payer, ...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  console.log(`  ${label}: ${sig}`);
  return sig;
};
if (!EXECUTE) { console.log("dry run — pass --execute to send"); process.exit(0); }

// 1. mint, authority RETAINED (freeze authority left null from the start)
const mint = Keypair.generate();
const rent = await conn.getMinimumBalanceForRentExemption(82);
const initMint = new TransactionInstruction({
  programId: TOK, keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true },
    { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false }],
  data: Buffer.concat([Buffer.from([0]), Buffer.from([DECIMALS]), payer.publicKey.toBuffer(), Buffer.from([0])]),
});
await send([
  SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey,
    lamports: rent, space: 82, programId: TOK }),
  initMint,
], [mint], "create mint");
console.log(`mint: ${mint.publicKey.toBase58()}`);

// 2. METADATA, while the authority still exists. This is the step the old mints can never have.
const str = (s) => { const b = Buffer.from(s, "utf8"); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
const [metadata] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), MPL.toBuffer(), mint.publicKey.toBuffer()], MPL);
const data = Buffer.concat([Buffer.from([33]), str(NAME), str(SYMBOL), str(URI),
  Buffer.from([0, 0]), Buffer.from([0]), Buffer.from([0]), Buffer.from([0]), Buffer.from([1]), Buffer.from([0])]);
await send([new TransactionInstruction({ programId: MPL, data, keys: [
  { pubkey: metadata, isSigner: false, isWritable: true },
  { pubkey: mint.publicKey, isSigner: false, isWritable: false },
  { pubkey: payer.publicKey, isSigner: true, isWritable: false },   // mint authority
  { pubkey: payer.publicKey, isSigner: true, isWritable: true },    // payer
  { pubkey: payer.publicKey, isSigner: false, isWritable: false },  // update authority (kept)
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
]})], [], "create metadata");
console.log(`metadata: ${metadata.toBase58()}`);

// 3. supply, then 4. renounce — in that order, since minting needs the authority.
const [ata] = PublicKey.findProgramAddressSync(
  [payer.publicKey.toBuffer(), TOK.toBuffer(), mint.publicKey.toBuffer()], ATOK);
await send([new TransactionInstruction({ programId: ATOK, data: Buffer.from([]), keys: [
  { pubkey: payer.publicKey, isSigner: true, isWritable: true },
  { pubkey: ata, isSigner: false, isWritable: true },
  { pubkey: payer.publicKey, isSigner: false, isWritable: false },
  { pubkey: mint.publicKey, isSigner: false, isWritable: false },
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  { pubkey: TOK, isSigner: false, isWritable: false },
]})], [], "create ATA");
const amount = Buffer.alloc(8); amount.writeBigUInt64LE(BigInt(SUPPLY) * 10n ** BigInt(DECIMALS));
await send([new TransactionInstruction({ programId: TOK,
  data: Buffer.concat([Buffer.from([7]), amount]),
  keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true },
    { pubkey: ata, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: false }] })], [], `mint ${SUPPLY}`);
await send([new TransactionInstruction({ programId: TOK,
  data: Buffer.from([6, 0, 0]), // SetAuthority: MintTokens, None
  keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: false }] })], [], "renounce mint authority");
console.log(`\nMINT: ${mint.publicKey.toBase58()}`);
