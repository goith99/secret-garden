/**
 * Secret Garden — DEVNET on-chain STATE DUMP (READ-ONLY, sends nothing, spends nothing).
 *
 * Diagnostic for the post-429 recovery: reports the real state of the MXE account, the
 * breed comp-def, and the breed raw-circuit account so we can decide whether a re-upload
 * is safe or whether accounts must be reset first. Safe to run repeatedly.
 *
 *   ANCHOR_PROVIDER_URL=$HELIUS_RPC_URL ANCHOR_WALLET=<wallet> ARCIUM_CLUSTER_OFFSET=456 \
 *     npx mocha --no-config --timeout 120000 scripts/devnet-state.ts
 */
import * as anchor from "@anchor-lang/core";
import * as arcium from "@arcium-hq/client";
import * as fs from "fs";
import type { SecretGarden } from "../target/types/secret_garden";

const { PublicKey } = anchor.web3;

describe("secret-garden DEVNET state dump (read-only)", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.SecretGarden as anchor.Program<SecretGarden>;
  const arciumProgram = arcium.getArciumProgram(provider);
  const programId = program.programId;
  const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];

  it("dumps MXE + comp-def + raw-circuit state", async function () {
    this.timeout(120_000);
    const conn = provider.connection;

    // --- GameConfig ---
    try {
      const cfg = await program.account.gameConfig.fetch(configPda);
      console.log(`\nGameConfig (${configPda.toBase58()}):`);
      console.log(`  authority=${cfg.authority.toBase58()} paused=${cfg.paused} round=${cfg.currentRound}`);
    } catch (e) {
      console.log(`\nGameConfig (${configPda.toBase58()}): NOT FOUND (${(e as Error).message})`);
    }

    // --- MXE account ---
    const mxeAddr = arcium.getMXEAccAddress(programId);
    const mxeInfo = await conn.getAccountInfo(mxeAddr);
    console.log(`\nMXE account (${mxeAddr.toBase58()}):`);
    if (!mxeInfo) {
      console.log(`  NOT FOUND on-chain`);
    } else {
      console.log(`  owner=${mxeInfo.owner.toBase58()} dataLen=${mxeInfo.data.length} lamports=${mxeInfo.lamports}`);
      try {
        const mxe = await arciumProgram.account.mxeAccount.fetch(mxeAddr);
        console.log(`  decoded keys: ${Object.keys(mxe).join(", ")}`);
        console.log(`  raw: ${JSON.stringify(mxe, (_k, v) =>
          typeof v === "bigint" ? v.toString() :
          v && v.toBase58 ? v.toBase58() : v).slice(0, 1200)}`);
      } catch (e) {
        console.log(`  could not decode as mxeAccount: ${(e as Error).message}`);
      }
    }

    // --- per-circuit comp-def + raw circuit account(s) ---
    const MAX_ACCOUNT_SIZE = 10485760;
    for (const circuit of ["breed", "score_entry", "reveal_top3"] as const) {
      const offset = arcium.getCompDefAccOffset(circuit);
      const compDefPda = PublicKey.findProgramAddressSync(
        [arcium.getArciumAccountBaseSeed("ComputationDefinitionAccount"), programId.toBuffer(), offset],
        arcium.getArciumProgramId(),
      )[0];
      console.log(`\n[${circuit}] comp-def (${compDefPda.toBase58()}):`);
      const cdInfo = await conn.getAccountInfo(compDefPda);
      if (!cdInfo) {
        console.log(`  NOT FOUND (comp-def not registered)`);
        continue;
      }
      try {
        const cd: any = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPda);
        const cs = cd.circuitSource;
        console.log(`  circuitSource keys: ${Object.keys(cs ?? {}).join(", ")}`);
        const onChain = cs && cs.onChain ? cs.onChain[0] : undefined;
        console.log(`  onChain.isCompleted = ${onChain ? onChain.isCompleted : "(not onChain source)"}`);
        console.log(`  finalized = ${cd.finalized ?? "n/a"}`);
      } catch (e) {
        console.log(`  could not decode comp-def: ${(e as Error).message}`);
      }

      // raw circuit account state (index 0..N based on local .arcis size)
      let localLen = 0;
      try { localLen = fs.statSync(`build/${circuit}.arcis`).size; } catch {}
      const numAccs = localLen ? Math.ceil(localLen / (MAX_ACCOUNT_SIZE - 9)) : 1;
      for (let i = 0; i < numAccs; i++) {
        const rawPda = arcium.getRawCircuitAccAddress(compDefPda, i);
        const rawInfo = await conn.getAccountInfo(rawPda);
        const requiredForFullSkip = localLen + 9; // SDK skip threshold (single-account case)
        if (!rawInfo) {
          console.log(`  raw[${i}] (${rawPda.toBase58()}): NOT FOUND`);
        } else {
          const data = rawInfo.data;
          // count trailing zero bytes after the 9-byte header to gauge how much was written
          let nonZero = 0;
          for (let b = 9; b < data.length; b++) if (data[b] !== 0) nonZero = b + 1;
          console.log(`  raw[${i}] (${rawPda.toBase58()}): dataLen=${data.length} ` +
            `(localCircuit=${localLen}, SDK-skip-threshold=${requiredForFullSkip}) ` +
            `lastNonZeroByte=${nonZero} ` +
            `=> ${data.length >= requiredForFullSkip ? "SDK WOULD SKIP re-upload" : "SDK would re-upload"}`);
        }
      }
    }
    console.log("");
  });
});
