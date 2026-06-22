/**
 * Secret Garden — DEVNET full setup, PHASE 2 (remaining comp defs).
 *
 * Run by scripts/devnet-deploy.sh `setup` phase, AFTER:
 *   - `arcium deploy` put the program + MXE on-chain, and
 *   - the `canary` phase (tests/breeding.ts) already created GameConfig AND registered
 *     the `breed` comp-def and proved Enc<Mxe> works on cluster 456.
 *
 * This script therefore registers ONLY the remaining two circuits — score_entry and
 * reveal_top3 — and does NOT init GameConfig or re-register breed (those exist already;
 * re-attempting them would fail "already in use"). Authority is the provider wallet,
 * which MUST equal the wallet that the canary used to init GameConfig.
 *
 * Run via mocha (Node v22 strips TS types natively, no ts-node needed):
 *   ANCHOR_PROVIDER_URL=$HELIUS_RPC_URL ANCHOR_WALLET=<wallet> ARCIUM_CLUSTER_OFFSET=456 \
 *     npx mocha --no-config --timeout 1800000 scripts/devnet-setup.ts
 *
 * Per-account idempotent-by-failure: if either initCompDef already succeeded in a prior
 * partial run, comment that circuit out and re-run the rest (see docs/DEVNET_DEPLOYMENT.md §5).
 */
import * as anchor from "@anchor-lang/core";
import * as arcium from "@arcium-hq/client";
import * as fs from "fs";
import type { SecretGarden } from "../target/types/secret_garden";

const { PublicKey } = anchor.web3;

describe("secret-garden DEVNET setup phase 2: score_entry + reveal_top3", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.SecretGarden as anchor.Program<SecretGarden>;
  const authority = provider.wallet.publicKey;

  const mxeAccount = arcium.getMXEAccAddress(program.programId);
  const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId)[0];

  async function initCompDef(
    circuit: "score_entry" | "reveal_top3",
    method: "initScoreEntryCompDef" | "initRevealTop3CompDef",
  ): Promise<void> {
    const offset = arcium.getCompDefAccOffset(circuit);
    const compDefPda = PublicKey.findProgramAddressSync(
      [arcium.getArciumAccountBaseSeed("ComputationDefinitionAccount"), program.programId.toBuffer(), offset],
      arcium.getArciumProgramId(),
    )[0];
    void compDefPda; void method;
    // SUPERSEDED — do NOT use the stock arcium.uploadCircuit() here. Its `chunkSize=500`
    // fires ~500 txs IN PARALLEL and 429'd on the breed upload (and would be worse on
    // reveal_top3, 644 txs). Both comp-def registration AND the byte-verified, bounded-
    // concurrency, HTTP-confirmed circuit upload are now handled by:
    //   UPLOAD_EXECUTE=yes CIRCUIT=<circuit> CONCURRENCY=8 ANCHOR_PROVIDER_URL=$HELIUS_RPC_URL \
    //     ANCHOR_WALLET=~/.config/solana/id.json ARCIUM_CLUSTER_OFFSET=456 \
    //     npx mocha --no-config --timeout 1800000 scripts/devnet-upload-circuit.ts
    // Run that once per circuit (score_entry, then reveal_top3).
    throw new Error(
      `devnet-setup.ts is superseded for '${circuit}': register+upload via ` +
      `scripts/devnet-upload-circuit.ts (CIRCUIT=${circuit} UPLOAD_EXECUTE=yes). ` +
      `Stock uploadCircuit(chunkSize=500) caused the breed 429.`,
    );
  }

  it("registers score_entry comp def (~0.70 SOL)", async function () {
    this.timeout(900_000);
    await initCompDef("score_entry", "initScoreEntryCompDef");
  });

  it("registers reveal_top3 comp def (~3.64 SOL)", async function () {
    this.timeout(1_800_000);
    await initCompDef("reveal_top3", "initRevealTop3CompDef");
  });
});
