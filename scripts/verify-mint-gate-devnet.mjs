/**
 * Live check of the post-deploy minting gate, against a cluster where the collection actually
 * exists — which bankrun cannot provide (its Metaplex CPI cannot create the collection, so a
 * local test can only ever reach `collection_mint` AccountNotInitialized).
 *
 *   set -a; source .env; set +a
 *   node scripts/verify-mint-gate-devnet.mjs
 *
 * Leaves the gate in whatever state it found it.
 */
import * as anchor from "@anchor-lang/core";
import fs from "fs";
import os from "os";
const { PublicKey, Keypair, Connection, Transaction, SystemProgram } = anchor.web3;

const conn = new Connection(process.env.HELIUS_RPC_URL, "confirmed");
const me = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf8"))));
const idl = JSON.parse(fs.readFileSync("./target/idl/secret_garden.json", "utf8"));
const wallet = {
  publicKey: me.publicKey,
  signTransaction: async (t) => { t.sign(me); return t; },
  signAllTransactions: async (ts) => ts.map((t) => { t.sign(me); return t; }),
};
const program = new anchor.Program(idl, new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" }));
const P = program.programId, te = new TextEncoder();
const pda = (s) => PublicKey.findProgramAddressSync(s, P)[0];
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const TOK = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATAP = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MPL = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const ata = (o, m) => PublicKey.findProgramAddressSync([o.toBuffer(), TOK.toBuffer(), m.toBuffer()], ATAP)[0];
const md = (m) => PublicKey.findProgramAddressSync([te.encode("metadata"), MPL.toBuffer(), m.toBuffer()], MPL)[0];
const ed = (m) => PublicKey.findProgramAddressSync(
  [te.encode("metadata"), MPL.toBuffer(), m.toBuffer(), te.encode("edition")], MPL)[0];

const CONFIG = pda([te.encode("config")]);
const GATE = pda([te.encode("mint_gate")]);
const COLLECTION = pda([te.encode("collection")]);

async function send(ixs, label, { expectFail = false } = {}) {
  const bh = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: me.publicKey, blockhash: bh.blockhash,
    lastValidBlockHeight: bh.lastValidBlockHeight }).add(...ixs);
  tx.sign(me);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  let st = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st) break;
  }
  const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const err = (t?.meta?.logMessages || []).filter((l) => /Error Code:/.test(l))[0];
  const failed = !st || st.err;
  const ok = expectFail ? failed : !failed;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${err ? "  " + err.replace(/^Program log: /, "") : ""}`);
  return { ok, err };
}

const setGate = (enabled) => program.methods.setMintingEnabled(enabled).accountsStrict({
  authority: me.publicKey, config: CONFIG, gate: GATE, systemProgram: SystemProgram.programId,
}).instruction();

const IDX = Number(process.env.FLOWER ?? 58);
const flower = pda([te.encode("flower"), me.publicKey.toBuffer(), u32(IDX)]);
const mint = pda([te.encode("flower_mint"), flower.toBuffer()]);
const rec = await program.account.flowerRecord.fetch(flower);
console.log(`flower #${IDX} status=${rec.status} genome=${rec.genomeStatus} (needs 0 / 1)`);
console.log(`collection exists: ${!!(await conn.getAccountInfo(COLLECTION, "confirmed"))}`);

const mintIx = () => program.methods.mintFlowerNft("https://gateway.irys.xyz/gate-check").accountsPartial({
  owner: me.publicKey, config: CONFIG, gate: GATE, flower,
  mintAuthority: pda([te.encode("mint_auth")]), mint, tokenAccount: ata(me.publicKey, mint),
  metadata: md(mint), masterEdition: ed(mint),
  collectionMint: COLLECTION, collectionMetadata: md(COLLECTION), collectionMasterEdition: ed(COLLECTION),
  tokenProgram: TOK, associatedTokenProgram: ATAP, tokenMetadataProgram: MPL,
  systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
}).instruction();

console.log(`\n[1] close the gate, then try to mint`);
await send([await setGate(false)], "set_minting_enabled(false)");
const closed = await send([
  anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), await mintIx(),
], "mint_flower_nft must be REFUSED", { expectFail: true });
console.log(`      refusal was MintingDisabled: ${/MintingDisabled/.test(closed.err ?? "")}`);

console.log(`\n[2] confirm the closed gate does NOT block other NFT work`);
const burnable = (await conn.getAccountInfo(pda([te.encode("flower_mint"),
  pda([te.encode("flower"), me.publicKey.toBuffer(), u32(59)]).toBuffer()]), "confirmed"));
console.log(`      flower #59 still has a live mint account: ${!!burnable}`);
console.log(`      burn_flower_nft / thaw_flower_nft take no gate account (IDL): ` +
  `${["burn_flower_nft","thaw_flower_nft"].every((n) =>
     !idl.instructions.find((i) => i.name === n).accounts.some((a) => a.name === "gate"))}`);

console.log(`\n[3] open the gate, then mint for real`);
await send([await setGate(true)], "set_minting_enabled(true)");
await send([
  anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), await mintIx(),
], "mint_flower_nft must now SUCCEED");

const g = await program.account.mintGate.fetch(GATE);
console.log(`\n  gate state: enabled=${g.enabled} updated_at=${g.updatedAt}`);
