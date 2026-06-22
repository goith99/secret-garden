/**
 * Secret Garden — DEVNET breeding-state diagnosis (READ-ONLY, sends nothing).
 * Reports GameConfig + PlayerProfile + flower/experiment slots for the operator wallet
 * so we can tell whether the breeding tests' index assumptions (starters 0..5,
 * nextFlowerIndex=6, no prior experiments) still hold after the partial canary.
 */
import * as anchor from "@anchor-lang/core";
import * as fs from "fs";
import * as os from "os";
import type { SecretGarden } from "../target/types/secret_garden";

const { PublicKey, Keypair } = anchor.web3;
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

describe("secret-garden DEVNET breeding-state (read-only)", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.SecretGarden as anchor.Program<SecretGarden>;
  const owner = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`).toString())),
  );
  const programId = program.programId;
  const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
  const profilePda = PublicKey.findProgramAddressSync(
    [Buffer.from("profile"), owner.publicKey.toBuffer()], programId)[0];
  const flowerPda = (i: number) => PublicKey.findProgramAddressSync(
    [Buffer.from("flower"), owner.publicKey.toBuffer(), u32le(i)], programId)[0];
  const experimentPda = (i: number) => PublicKey.findProgramAddressSync(
    [Buffer.from("experiment"), owner.publicKey.toBuffer(), u32le(i)], programId)[0];

  it("dumps breeding state", async function () {
    this.timeout(60_000);
    console.log(`\nowner = ${owner.publicKey.toBase58()}`);

    try {
      const cfg: any = await program.account.gameConfig.fetch(configPda);
      console.log(`GameConfig: authority=${cfg.authority.toBase58()} paused=${cfg.paused} currentRound=${cfg.currentRound}`);
      console.log(`  authority == owner? ${cfg.authority.equals(owner.publicKey)}`);
    } catch (e) { console.log(`GameConfig: NOT FOUND (${(e as Error).message})`); }

    try {
      const p: any = await program.account.playerProfile.fetch(profilePda);
      console.log(`PlayerProfile: nextFlowerIndex=${p.nextFlowerIndex} totalExperiments=${p.totalExperiments} activeExperimentCount=${p.activeExperimentCount}`);
    } catch (e) { console.log(`PlayerProfile: NOT FOUND (${(e as Error).message})`); }

    console.log(`flowers:`);
    for (let i = 0; i < 12; i++) {
      try {
        const f: any = await program.account.flowerRecord.fetch(flowerPda(i));
        console.log(`  flower[${i}]: status=${f.status} genomeStatus=${f.genomeStatus} generation=${f.generation} visualSpecies=${f.visualSpeciesId}`);
      } catch { /* not present */ }
    }
    console.log(`experiments:`);
    for (let i = 0; i < 8; i++) {
      try {
        const e: any = await program.account.experiment.fetch(experimentPda(i));
        console.log(`  experiment[${i}]: status=${e.status} callbackProcessed=${e.callbackProcessed}`);
      } catch { /* not present */ }
    }
    console.log("");
  });
});
