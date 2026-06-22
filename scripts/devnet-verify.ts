/**
 * Secret Garden — DEVNET post-deploy verification (READ-ONLY, sends no transactions).
 * Invoked by scripts/devnet-verify.sh. Fetches and prints state; never writes.
 */
import * as anchor from "@anchor-lang/core";
import * as arcium from "@arcium-hq/client";
import { expect } from "chai";
import type { SecretGarden } from "../target/types/secret_garden";

const { PublicKey } = anchor.web3;

describe("secret-garden DEVNET verify (read-only)", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.SecretGarden as anchor.Program<SecretGarden>;
  const arciumProgram = arcium.getArciumProgram(provider);
  const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId)[0];

  it("GameConfig exists with expected initial values", async function () {
    this.timeout(60_000);
    const cfg = await program.account.gameConfig.fetch(configPda);
    console.log(`  GameConfig: authority=${cfg.authority.toBase58()} paused=${cfg.paused} round=${cfg.currentRound}`);
    expect(cfg.paused).to.equal(false);
    expect(cfg.currentRound.toString()).to.equal("0");
  });

  it("all 3 computation definitions are registered", async function () {
    this.timeout(60_000);
    for (const circuit of ["breed", "score_entry", "reveal_top3"] as const) {
      const offset = arcium.getCompDefAccOffset(circuit);
      const compDefPda = PublicKey.findProgramAddressSync(
        [arcium.getArciumAccountBaseSeed("ComputationDefinitionAccount"), program.programId.toBuffer(), offset],
        arcium.getArciumProgramId(),
      )[0];
      const acc = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPda);
      console.log(`  comp def ${circuit}: ${compDefPda.toBase58()} (finalized=${(acc as any).finalized ?? "n/a"})`);
      expect(acc).to.not.equal(null);
    }
  });
});
