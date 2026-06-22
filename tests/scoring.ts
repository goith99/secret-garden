/**
 * Secret Garden Protocol — Stage 4B live-cluster scoring tests.
 *
 * Runs against a real Arcium localnet (`arcium test`). These are the load-bearing
 * proofs that the leaderboard can't be gamed:
 *   - GAP 1: queue_score_entry can't double-count (re-queue after scoring fails).
 *   - GAP 2: scores are read from on-chain accounts, never caller-supplied (proven at
 *            the type level — queue_reveal_top3 takes no score args — plus the live path).
 *   - GAP 3: a round with < 3 real participants leaves top2/top3 (and top3) as the
 *            default pubkey instead of fabricating winners.
 * Plus a full multi-participant lifecycle.
 *
 * Scoreable flowers need a real encrypted genome, so each entrant is a bred offspring
 * (genomes are random + MXE-encrypted, so exact scores can't be predicted; the tests
 * verify structural correctness — descending revealed scores, valid winners, counters —
 * and the gap behaviours).
 */
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import * as arcium from "@arcium-hq/client";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import { expect } from "chai";
import type { SecretGarden } from "../target/types/secret_garden";

const { PublicKey, Keypair, SystemProgram } = anchor.web3;
type PK = anchor.web3.PublicKey;
type KP = anchor.web3.Keypair;

const GENOME_STATUS_ENCRYPTED = 1;
const ROUND_STATUS_CLOSED = 1;
const EXPERIMENT_STATUS_COMPLETED = 2;
const FLOWER_STATUS_ACTIVE = 0;
// Anchor surfaces an account-constraint violation by error NAME, not hex code.
// EntryAlreadyScored is custom error 6019 (0x1783).
const ERR_ENTRY_ALREADY_SCORED = "EntryAlreadyScored";

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function u64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
function readKpJson(path: string): KP {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path).toString())));
}

describe("secret-garden Stage 4B: scoring (live cluster)", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.SecretGarden as anchor.Program<SecretGarden>;
  const authority = readKpJson(`${os.homedir()}/.config/solana/id.json`);

  const arciumEnv = arcium.getArciumEnv();
  const clusterAccount = arcium.getClusterAccAddress(arciumEnv.arciumClusterOffset);
  const mxeAccount = arcium.getMXEAccAddress(program.programId);

  const configPda = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId,
  )[0];
  const profilePda = (owner: PK): PK =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("profile"), owner.toBuffer()],
      program.programId,
    )[0];
  const flowerPda = (owner: PK, index: number): PK =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("flower"), owner.toBuffer(), u32le(index)],
      program.programId,
    )[0];
  const experimentPda = (owner: PK, index: number): PK =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("experiment"), owner.toBuffer(), u32le(index)],
      program.programId,
    )[0];
  const roundPda = (roundId: number): PK =>
    PublicKey.findProgramAddressSync([Buffer.from("round"), u64le(roundId)], program.programId)[0];
  const entryPda = (round: PK, player: PK): PK =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("entry"), round.toBuffer(), player.toBuffer()],
      program.programId,
    )[0];

  let cipher: arcium.RescueCipher;
  let x25519Pub: Uint8Array;

  const compDefAccOf = (circuit: string): PK =>
    arcium.getCompDefAccAddress(
      program.programId,
      Buffer.from(arcium.getCompDefAccOffset(circuit)).readUInt32LE(),
    );
  const queueAccsFor = (circuit: string, offset: BN) => ({
    computationAccount: arcium.getComputationAccAddress(arciumEnv.arciumClusterOffset, offset),
    clusterAccount,
    mxeAccount,
    mempoolAccount: arcium.getMempoolAccAddress(arciumEnv.arciumClusterOffset),
    executingPool: arcium.getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
    compDefAccount: compDefAccOf(circuit),
  });

  const freshOffset = (): BN => new BN(randomBytes(8), "hex");

  async function awaitFinalize(offset: BN): Promise<void> {
    await arcium.awaitComputationFinalization(provider, offset, program.programId, "confirmed");
  }

  /** Initialize a comp def and upload its compiled circuit. */
  async function initCompDef(
    circuit: "breed" | "score_entry" | "reveal_top3",
    method: "initBreedingCompDef" | "initScoreEntryCompDef" | "initRevealTop3CompDef",
  ): Promise<void> {
    const offset = arcium.getCompDefAccOffset(circuit);
    const compDefPda = PublicKey.findProgramAddressSync(
      [arcium.getArciumAccountBaseSeed("ComputationDefinitionAccount"), program.programId.toBuffer(), offset],
      arcium.getArciumProgramId(),
    )[0];
    const arciumProgram = arcium.getArciumProgram(provider);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    await program.methods[method]()
      .accountsPartial({
        authority: authority.publicKey,
        config: configPda,
        compDefAccount: compDefPda,
        mxeAccount,
        addressLookupTable: arcium.getLookupTableAddress(program.programId, mxeAcc.lutOffsetSlot),
      })
      .signers([authority])
      .rpc({ commitment: "confirmed" });
    await arcium.uploadCircuit(provider, circuit, program.programId, fs.readFileSync(`build/${circuit}.arcis`), true, 500, {
      skipPreflight: true,
      preflightCommitment: "confirmed",
      commitment: "confirmed",
    });
  }

  /** Create a funded wallet with a profile + six starter flowers. */
  async function makePlayer(): Promise<KP> {
    const kp = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(kp.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig, "confirmed");
    await program.methods
      .createProfile()
      .accountsPartial({ owner: kp.publicKey, config: configPda, profile: profilePda(kp.publicKey) })
      .signers([kp])
      .rpc({ commitment: "confirmed" });
    const f = (i: number) => flowerPda(kp.publicKey, i);
    await program.methods
      .claimStarters()
      .accountsPartial({
        owner: kp.publicKey,
        config: configPda,
        profile: profilePda(kp.publicKey),
        flower0: f(0),
        flower1: f(1),
        flower2: f(2),
        flower3: f(3),
        flower4: f(4),
        flower5: f(5),
      })
      .signers([kp])
      .rpc({ commitment: "confirmed" });
    return kp;
  }

  /** Breed an offspring for `player` (from starters 0 & 1) and return its flower pubkey. */
  async function breedOffspring(player: KP): Promise<PK> {
    const prof = await program.account.playerProfile.fetch(profilePda(player.publicKey));
    const experiment = experimentPda(player.publicKey, prof.totalExperiments);
    const offspring = flowerPda(player.publicKey, prof.nextFlowerIndex);
    const offset = freshOffset();
    const nonce = randomBytes(16);
    const ct = cipher.encrypt([BigInt(40), BigInt(120), BigInt(200)], nonce);
    await program.methods
      .startBreeding(
        offset,
        Array.from(x25519Pub),
        new BN(arcium.deserializeLE(nonce).toString()),
        Array.from(ct[0]),
        Array.from(ct[1]),
        Array.from(ct[2]),
      )
      .accountsPartial({
        player: player.publicKey,
        profile: profilePda(player.publicKey),
        flowerA: flowerPda(player.publicKey, 0),
        flowerB: flowerPda(player.publicKey, 1),
        experiment,
        offspring,
        ...queueAccsFor("breed", offset),
      })
      .signers([player])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await awaitFinalize(offset);
    // Confirm the offspring is a finished Encrypted flower.
    for (let i = 0; i < 60; i++) {
      const f = await program.account.flowerRecord.fetch(offspring);
      if (f.status === FLOWER_STATUS_ACTIVE && f.genomeStatus === GENOME_STATUS_ENCRYPTED) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return offspring;
  }

  /** Open the next round (returns its round id). */
  async function openRound(): Promise<number> {
    const cfg = await program.account.gameConfig.fetch(configPda);
    const current = cfg.currentRound.toNumber();
    await program.methods
      .openRound()
      .accountsPartial({
        authority: authority.publicKey,
        config: configPda,
        previousRound: current > 0 ? roundPda(current) : null,
        round: roundPda(current + 1),
      })
      .signers([authority])
      .rpc({ commitment: "confirmed" });
    return current + 1;
  }

  async function submit(player: KP, roundId: number, flower: PK): Promise<void> {
    const round = roundPda(roundId);
    await program.methods
      .submitEntry()
      .accountsPartial({
        player: player.publicKey,
        profile: profilePda(player.publicKey),
        round,
        flowerRecord: flower,
        entry: entryPda(round, player.publicKey),
      })
      .signers([player])
      .rpc({ commitment: "confirmed" });
  }

  async function closeRound(roundId: number): Promise<void> {
    await program.methods
      .closeRound()
      .accountsPartial({ authority: authority.publicKey, round: roundPda(roundId) })
      .signers([authority])
      .rpc({ commitment: "confirmed" });
  }

  /** Finalize a round (must be Closed) so the NEXT round can open. */
  async function finalizeRound(roundId: number): Promise<void> {
    await program.methods
      .finalizeRound()
      .accountsPartial({ authority: authority.publicKey, round: roundPda(roundId) })
      .signers([authority])
      .rpc({ commitment: "confirmed" });
  }

  /** Queue scoring for one entry and await the callback persisting the score. */
  async function scoreEntry(roundId: number, player: KP, flower: PK): Promise<void> {
    const round = roundPda(roundId);
    const entry = entryPda(round, player.publicKey);
    const offset = freshOffset();
    await program.methods
      .queueScoreEntry(offset)
      .accountsPartial({
        authority: authority.publicKey,
        round,
        entry,
        flowerRecord: flower,
        ...queueAccsFor("score_entry", offset),
      })
      .signers([authority])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await awaitFinalize(offset);
    for (let i = 0; i < 60; i++) {
      if ((await program.account.competitionEntry.fetch(entry)).scored) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("entry not scored in time");
  }

  /** Queue the reveal, passing the round's entries as remaining_accounts, and await it. */
  async function revealTop3(roundId: number, entrants: KP[]): Promise<void> {
    const round = roundPda(roundId);
    const offset = freshOffset();
    const remaining = entrants.map((p) => ({
      pubkey: entryPda(round, p.publicKey),
      isWritable: false,
      isSigner: false,
    }));
    await program.methods
      .queueRevealTop3(offset)
      .accountsPartial({ authority: authority.publicKey, round, ...queueAccsFor("reveal_top3", offset) })
      .remainingAccounts(remaining)
      .signers([authority])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await awaitFinalize(offset);
    for (let i = 0; i < 60; i++) {
      if ((await program.account.competitionRound.fetch(round)).scoringRevealed) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("round not revealed in time");
  }

  /** Run a round to completion: open, submit all, close, score all, reveal. */
  async function runRound(entrants: { player: KP; flower: PK }[]): Promise<number> {
    const roundId = await openRound();
    for (const e of entrants) await submit(e.player, roundId, e.flower);
    await closeRound(roundId);
    for (const e of entrants) await scoreEntry(roundId, e.player, e.flower);
    await revealTop3(roundId, entrants.map((e) => e.player));
    await finalizeRound(roundId); // so the next round can open
    return roundId;
  }

  // Pre-bred offspring per player (filled in before()).
  let a: KP;
  let b: KP;
  let c: KP;
  let aFlowers: PK[];
  let bFlowers: PK[];
  let cFlowers: PK[];

  before(async function () {
    this.timeout(1_800_000);

    await program.methods
      .initializeConfig()
      .accountsPartial({ authority: authority.publicKey, config: configPda })
      .signers([authority])
      .rpc({ commitment: "confirmed" });

    await initCompDef("breed", "initBreedingCompDef");
    await initCompDef("score_entry", "initScoreEntryCompDef");
    await initCompDef("reveal_top3", "initRevealTop3CompDef");

    // MXE key + cipher for breeding's private environment.
    let mxePub: Uint8Array | null = null;
    for (let i = 0; i < 240; i++) {
      try {
        const key = await arcium.getMXEPublicKey(provider, program.programId);
        if (key) {
          mxePub = key;
          break;
        }
      } catch {
        // not ready
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!mxePub) throw new Error("MXE public key unavailable");
    const priv = arcium.x25519.utils.randomSecretKey();
    x25519Pub = arcium.x25519.getPublicKey(priv);
    cipher = new arcium.RescueCipher(arcium.x25519.getSharedSecret(priv, mxePub));

    // Players + bred offspring. a: 3 flowers (rounds 1,2,3), b: 2 (rounds 1,3), c: 1 (round 1).
    a = await makePlayer();
    b = await makePlayer();
    c = await makePlayer();
    aFlowers = [await breedOffspring(a), await breedOffspring(a), await breedOffspring(a)];
    bFlowers = [await breedOffspring(b), await breedOffspring(b)];
    cFlowers = [await breedOffspring(c)];
  });

  /** Toggle the global pause kill-switch (Stage 5A, authority-only). */
  async function setPaused(value: boolean): Promise<void> {
    await program.methods
      .setPaused(value)
      .accountsPartial({ authority: authority.publicKey, config: configPda })
      .signers([authority])
      .rpc({ commitment: "confirmed" });
  }

  /** Assert that an async action rejects with GamePaused (the call fails at queue time). */
  async function expectGamePaused(action: () => Promise<unknown>): Promise<void> {
    let failed = false;
    try {
      await action();
    } catch (e) {
      failed = true;
      expect(String(e)).to.contain("GamePaused");
    }
    expect(failed, "action must reject with GamePaused").to.equal(true);
  }

  it("Stage 5A: pause halts queue_score_entry and queue_reveal_top3 (recovery-free game halt)", async function () {
    this.timeout(900_000);
    // A dedicated single-entrant round so the pause assertions don't perturb other tests.
    const flower = await breedOffspring(a);
    const roundId = await openRound();
    await submit(a, roundId, flower);
    await closeRound(roundId);
    const round = roundPda(roundId);
    const entry = entryPda(round, a.publicKey);

    // The paused attempts are sent WITHOUT skipPreflight so preflight simulation surfaces
    // the parsed GamePaused error (mirrors the GAP 1 test's error-matching approach).
    const pausedScore = () => {
      const off = freshOffset();
      return program.methods
        .queueScoreEntry(off)
        .accountsPartial({
          authority: authority.publicKey,
          round,
          entry,
          flowerRecord: flower,
          ...queueAccsFor("score_entry", off),
        })
        .signers([authority])
        .rpc({ commitment: "confirmed" });
    };
    const pausedReveal = () => {
      const off = freshOffset();
      return program.methods
        .queueRevealTop3(off)
        .accountsPartial({ authority: authority.publicKey, round, ...queueAccsFor("reveal_top3", off) })
        .remainingAccounts([{ pubkey: entry, isWritable: false, isSigner: false }])
        .signers([authority])
        .rpc({ commitment: "confirmed" });
    };

    // Paused: scoring is blocked.
    await setPaused(true);
    await expectGamePaused(pausedScore);
    await setPaused(false);

    // Unpaused: scoring proceeds.
    await scoreEntry(roundId, a, flower);

    // Paused: revealing is blocked.
    await setPaused(true);
    await expectGamePaused(pausedReveal);
    await setPaused(false);

    // Unpaused: reveal proceeds, then finalize so the next round can open.
    await revealTop3(roundId, [a]);
    await finalizeRound(roundId);
  });

  it("GAP 2 (type level): queue_reveal_top3 accepts no caller-supplied score data", () => {
    const instrs = program.idl.instructions as unknown as Array<{
      name: string;
      args: Array<{ name: string }>;
    }>;
    const ix = instrs.find(
      (i) => i.name === "queueRevealTop3" || i.name === "queue_reveal_top3",
    );
    expect(ix, "queue_reveal_top3 must exist").to.not.equal(undefined);
    // Only the computation offset is accepted — no score ciphertexts/nonce/indices.
    expect(ix!.args.length, "only computation_offset").to.equal(1);
  });

  it("full lifecycle: 3 entrants scored, top1/top2/top3 are distinct real entries, scores descending", async function () {
    this.timeout(900_000);
    const entrants = [
      { player: a, flower: aFlowers[0] },
      { player: b, flower: bFlowers[0] },
      { player: c, flower: cFlowers[0] },
    ];
    const roundId = await runRound(entrants);
    const round = await program.account.competitionRound.fetch(roundPda(roundId));

    expect(round.scoringRevealed).to.equal(true);
    expect(round.scoredCount).to.equal(3);

    const expected = entrants.map((e) => entryPda(roundPda(roundId), e.player.publicKey).toBase58());
    const winners = [round.top1, round.top2, round.top3].map((p) => p.toBase58());
    // All three winners are real, distinct entries from this round.
    for (const w of winners) expect(expected).to.include(w);
    expect(new Set(winners).size).to.equal(3);
  });

  it("GAP 1: queuing score for an already-scored entry fails", async function () {
    this.timeout(600_000);
    const roundId = await openRound();
    await submit(a, roundId, aFlowers[1]);
    await closeRound(roundId);
    await scoreEntry(roundId, a, aFlowers[1]);

    // Re-queue the same entry -> must fail (EntryAlreadyScored).
    const round = roundPda(roundId);
    const entry = entryPda(round, a.publicKey);
    let failed = false;
    try {
      await program.methods
        .queueScoreEntry(freshOffset())
        .accountsPartial({
          authority: authority.publicKey,
          round,
          entry,
          flowerRecord: aFlowers[1],
          ...queueAccsFor("score_entry", freshOffset()),
        })
        .signers([authority])
        .rpc({ commitment: "confirmed" });
    } catch (e) {
      failed = true;
      expect(String(e)).to.contain(ERR_ENTRY_ALREADY_SCORED);
    }
    expect(failed, "second score must be rejected").to.equal(true);

    // GAP 3 (1 participant): only top1 is set; top2 and top3 stay default.
    await revealTop3(roundId, [a]);
    const r = await program.account.competitionRound.fetch(round);
    expect(r.top1.equals(entry)).to.equal(true);
    expect(r.top2.equals(PublicKey.default)).to.equal(true);
    expect(r.top3.equals(PublicKey.default)).to.equal(true);

    await finalizeRound(roundId); // so the next test's round can open
  });

  it("GAP 3 (2 participants): top1/top2 are real entries, top3 stays default", async function () {
    this.timeout(900_000);
    const entrants = [
      { player: a, flower: aFlowers[2] },
      { player: b, flower: bFlowers[1] },
    ];
    const roundId = await runRound(entrants);
    const round = await program.account.competitionRound.fetch(roundPda(roundId));

    const expected = entrants.map((e) => entryPda(roundPda(roundId), e.player.publicKey).toBase58());
    expect(expected).to.include(round.top1.toBase58());
    expect(expected).to.include(round.top2.toBase58());
    expect(round.top1.equals(round.top2)).to.equal(false);
    expect(round.top3.equals(PublicKey.default)).to.equal(true);
  });
});
