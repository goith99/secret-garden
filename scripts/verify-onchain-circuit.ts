/**
 * READ-ONLY: dump the on-chain finalized `breed` circuit bytes and compare byte-for-byte
 * against local build/breed.arcis. Diagnoses the "stale finalize" trap (comp-def isCompleted
 * but the raw account still holds old bytes). No transactions — free.
 *
 * Run (FOREGROUND):
 *   set -a; source .env; set +a
 *   ANCHOR_PROVIDER_URL=$HELIUS_RPC_URL ANCHOR_WALLET=~/.config/solana/id.json \
 *     ARCIUM_CLUSTER_OFFSET=456 npx mocha --no-config --timeout 120000 \
 *     scripts/verify-onchain-circuit.ts
 */
import * as anchor from "@anchor-lang/core";
import * as arcium from "@arcium-hq/client";
import { createHash } from "crypto";
import * as fs from "fs";
import type { SecretGarden } from "../target/types/secret_garden";

const { PublicKey } = anchor.web3;
const RAW_HEADER = 9; // 8-byte discriminator + 1-byte bump
const CIRCUIT = (process.env.CIRCUIT ?? "breed") as string;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe(`verify on-chain circuit bytes: ${CIRCUIT}`, () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.SecretGarden as anchor.Program<SecretGarden>;
  const arciumProgram = arcium.getArciumProgram(provider);
  const conn = provider.connection;
  const programId = program.programId;

  it("reports on-chain vs local circuit bytes (read-only)", async function () {
    this.timeout(120000);
    const local = fs.readFileSync(`build/${CIRCUIT}.arcis`);
    const compDefPda = PublicKey.findProgramAddressSync(
      [arcium.getArciumAccountBaseSeed("ComputationDefinitionAccount"), programId.toBuffer(),
        arcium.getCompDefAccOffset(CIRCUIT)],
      arcium.getArciumProgramId())[0];
    const rawPda = arcium.getRawCircuitAccAddress(compDefPda, 0);

    const cd: any = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPda);
    const isCompleted = cd.circuitSource?.onChain?.[0]?.isCompleted;
    console.log(`\ncomp-def: ${compDefPda.toBase58()}  isCompleted=${isCompleted}`);

    const rawInfo = await conn.getAccountInfo(rawPda);
    if (!rawInfo) throw new Error(`raw circuit account ${rawPda.toBase58()} not found`);
    const onchain = Buffer.from(rawInfo.data.subarray(RAW_HEADER, RAW_HEADER + local.length));

    console.log(`\nLOCAL   build/${CIRCUIT}.arcis : len=${local.length}  sha=${sha(local)}`);
    console.log(`ONCHAIN raw circuit account   : len=${onchain.length}  sha=${sha(onchain)}  (rawAcct dataLen=${rawInfo.data.length})`);

    const match = onchain.length === local.length && onchain.equals(local);
    if (match) {
      console.log(`\n✅ MATCH — on-chain finalized circuit == local build/${CIRCUIT}.arcis (byte-for-byte).`);
    } else {
      let m = -1;
      const n = Math.min(onchain.length, local.length);
      for (let b = 0; b < n; b++) if (onchain[b] !== local[b]) { m = b; break; }
      console.log(`\n❌ MISMATCH — on-chain finalized circuit != local build/${CIRCUIT}.arcis.`);
      console.log(`   first differing byte: ${m >= 0 ? m : "(none in overlap; length differs)"}`);
      console.log(`   => the live circuit is NOT the packed-mask build; a stale circuit is finalized on-chain.`);
    }
  });
});
