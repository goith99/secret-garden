/**
 * One-off tool: kept for any profile still on the pre-Stage-5D 68-byte layout. Safe to
 * delete once all active devnet profiles are confirmed migrated.
 *
 * The `PlayerProfile` layout grew by 5 bytes in Stage 5D (`breeds_this_round: u8`,
 * `last_breed_round: u32` appended at the end). Existing devnet accounts are 68 bytes
 * (8 disc + 60 body); the new struct expects 73 (8 + 65). Anchor 1.0.2 fails to read the
 * old account with AccountDidNotDeserialize (0xbbb).
 *
 * We DO NOT close + recreate: the wallet's profile has live state (claimed starters, many
 * flowers, experiment counters) and recreating a fresh profile would orphan the existing
 * FlowerRecord PDAs and desync `next_flower_index`. Instead this calls the program's
 * `migrate_profile` instruction, which reallocs the PDA +5 bytes IN PLACE, preserving every
 * existing field and zero-filling the two new ones. Idempotent.
 *
 * Requires the Stage 5D program (with `migrate_profile`) to be deployed to devnet first.
 *
 * Run:
 *   source .env && ANCHOR_PROVIDER_URL=$HELIUS_RPC_URL \
 *     ANCHOR_WALLET=$HOME/.config/solana/id.json ARCIUM_CLUSTER_OFFSET=456 \
 *     npx mocha --no-config --timeout 60000 scripts/migrate-profile.ts
 */
import * as anchor from "@anchor-lang/core";
import * as fs from "fs";
import * as os from "os";
import { expect } from "chai";
import type { SecretGarden } from "../target/types/secret_garden";

const { PublicKey, Transaction, SystemProgram } = anchor.web3;

const NEW_DATA_LEN = 73; // 8 discriminator + 65 body (post-5D)

function readKpJson(path: string): anchor.web3.Keypair {
  return anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(path).toString())),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Decode the old (pre-5D, 60-byte body) PlayerProfile fields from raw bytes. */
function decodeOld(d: Buffer) {
  return {
    owner: new PublicKey(d.subarray(8, 40)).toBase58(),
    starterClaimed: d[40] === 1,
    totalFlowers: d.readUInt16LE(41),
    totalCrosses: d.readUInt16LE(43),
    dailyAttempts: d[45],
    finalSubmissions: d[46],
    activeExperimentCount: d.readUInt32LE(55),
    totalExperiments: d.readUInt32LE(59),
    nextFlowerIndex: d.readUInt32LE(63),
    bump: d[67],
  };
}

describe("DEVNET migrate PlayerProfile to Stage 5D layout", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const conn = provider.connection;
  const program = anchor.workspace.SecretGarden as anchor.Program<SecretGarden>;
  const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);

  const profilePda = PublicKey.findProgramAddressSync(
    [Buffer.from("profile"), owner.publicKey.toBuffer()],
    program.programId,
  )[0];

  /** HTTP-only send + confirm (no WebSocket; the configured RPC is HTTP-only). */
  async function sendTxHttp(ix: anchor.web3.TransactionInstruction): Promise<string> {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const bh = await conn.getLatestBlockhash({ commitment: "confirmed" });
      const tx = new Transaction();
      tx.add(ix);
      tx.recentBlockhash = bh.blockhash;
      tx.lastValidBlockHeight = bh.lastValidBlockHeight;
      tx.feePayer = owner.publicKey;
      tx.sign(owner);
      let sig: string;
      try {
        sig = await conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          maxRetries: 0,
          preflightCommitment: "confirmed",
        });
      } catch (e) {
        console.log(`    send err (attempt ${attempt}): ${(e as Error).message.slice(0, 120)}`);
        await sleep(Math.min(6000, 500 * 2 ** (attempt - 1)));
        continue;
      }
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        const st = (await conn.getSignatureStatuses([sig])).value[0];
        if (st) {
          if (st.err) throw new Error(`migrate tx FAILED on-chain: ${JSON.stringify(st.err)} (sig ${sig})`);
          if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return sig;
        }
        const h = await conn.getBlockHeight({ commitment: "confirmed" });
        if (h > bh.lastValidBlockHeight) break;
        await sleep(800);
      }
      console.log(`    not confirmed (attempt ${attempt}); retrying`);
    }
    throw new Error("migrate failed to confirm after retries");
  }

  it("reallocs the stale profile in place and preserves all state", async function () {
    this.timeout(60_000);

    console.log(`  wallet : ${owner.publicKey.toBase58()}`);
    console.log(`  profile: ${profilePda.toBase58()}`);

    // 1. Read raw (Anchor decode would throw 0xbbb on the old layout).
    const before = await conn.getAccountInfo(profilePda);
    if (!before) throw new Error("profile PDA does not exist on devnet — nothing to migrate");
    expect(before.owner.equals(program.programId), "profile must be program-owned").to.equal(true);
    console.log(`  before : ${before.data.length} bytes, ${before.lamports} lamports`);

    if (before.data.length >= NEW_DATA_LEN) {
      console.log("  already migrated (>= 73 bytes); verifying it decodes cleanly.");
    } else {
      const old = decodeOld(before.data);
      console.log("  pre-migration state:", JSON.stringify(old));

      // 2. Migrate (idempotent; reallocs +5 bytes, zero-fills the new fields).
      const ix = await program.methods
        .migrateProfile()
        .accountsStrict({
          owner: owner.publicKey,
          profile: profilePda,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      const sig = await sendTxHttp(ix);
      console.log(`  migrate tx confirmed: ${sig}`);

      // 3. Confirm the account grew and prior fields are byte-identical.
      const after = await conn.getAccountInfo(profilePda);
      expect(after!.data.length, "account should be 73 bytes after migration").to.equal(NEW_DATA_LEN);
      expect(
        Buffer.compare(after!.data.subarray(0, 68), before.data),
        "the original 68 bytes must be unchanged",
      ).to.equal(0);
      expect(after!.data[68], "breeds_this_round byte should be 0").to.equal(0);
      expect(after!.data.readUInt32LE(69), "last_breed_round should be 0").to.equal(0);
    }

    // 4. Now it decodes via Anchor; report + assert the Stage 5D invariants.
    const p = await program.account.playerProfile.fetch(profilePda);
    console.log("  post-migration profile:", {
      owner: p.owner.toBase58(),
      starterClaimed: p.starterClaimed,
      totalFlowers: p.totalFlowers,
      totalCrosses: p.totalCrosses,
      totalExperiments: p.totalExperiments,
      nextFlowerIndex: p.nextFlowerIndex,
      breedsThisRound: p.breedsThisRound,
      lastBreedRound: p.lastBreedRound,
      bump: p.bump,
    });
    expect(p.owner.equals(owner.publicKey), "owner preserved").to.equal(true);
    expect(p.breedsThisRound, "breeds_this_round must be 0").to.equal(0);
    expect(p.lastBreedRound, "last_breed_round must be 0").to.equal(0);

    console.log("  ✅ migration complete — profile is now Stage 5D compatible.");
  });
});
