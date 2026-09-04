/**
 * H-1: the single-shard endgame must serve the MPC ranking, not pubkey order.
 *
 * `collect_shard_winners` writes `BracketState.finalists` in RANK order, and for a one-shard
 * bracket `apply_bracket_result` reads that array POSITIONALLY as top1/top2/top3. That is only
 * sound while nothing rewrites the array — and one thing does: `queue_shard_reveal(FINAL)`
 * replaces it with the same set in pubkey-ascending order (the order the final reveal's slot
 * indices address). Nothing in the program stopped that final reveal from running on a one-shard
 * bracket, where it is pure corruption: first place silently becomes "whichever finalist's entry
 * PDA sorts first".
 *
 * Entry PDAs are `[ENTRY_SEED, round, player]`, so a player picks their own by grinding a
 * keypair offline. Every round of <= MAX_SHARD_SIZE (13) entrants is one shard, and in a round
 * of three every entrant is a finalist — so at today's participation the grind alone decides
 * the winner.
 *
 * The three cases below share one 3-entrant round in which the true MPC rank-1 is the entry that
 * sorts LAST and the attacker, genuinely ranked THIRD, sorts FIRST:
 *
 *   1. pre-fix behaviour   — the reordered array really does crown the attacker (the damage)
 *   2. post-fix            — the state a final reveal actually leaves behind is now refused
 *   3. honest path         — an untouched bracket still crowns the real MPC rank-1
 *
 * The queue-side guard that prevents (2) from ever arising cannot be driven from here: the
 * `QueueShardReveal` context requires live Arcium accounts that bankrun has no way to seed, so
 * Anchor rejects the call before the handler runs. It is covered by the Rust unit test
 * `a_one_shard_bracket_never_needs_a_final_reveal`, and the corrupted state it would have
 * produced is reproduced below exactly as the handler writes it: `finalists[0..n]` overwritten
 * ascending, `final_queued = true`.
 */
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { assert, expect } from "chai";
import { Harness } from "./harness.ts";

const { PublicKey, Keypair } = anchor.web3;
type PK = anchor.web3.PublicKey;

const FINAL_REVEAL_NOT_APPLICABLE = "0x17bf"; // 6079
const ROUND_STATUS_CLOSED = 1;
const N = 3; // one shard, and every entrant is a finalist — today's typical round

function cmp(a: PK, b: PK): number {
  const x = a.toBytes(), y = b.toBytes();
  for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
function u64le(n: number | bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

describe("single-shard final reveal (H-1: rank order vs pubkey order)", () => {
  const bracketPda = (h: Harness, round: PK) =>
    PublicKey.findProgramAddressSync([Buffer.from("bracket"), round.toBuffer()], h.program.programId)[0];
  const shardResPda = (h: Harness, round: PK, i: number) =>
    PublicKey.findProgramAddressSync([Buffer.from("shardres"), round.toBuffer(), Buffer.from([i])], h.program.programId);

  /**
   * A CLOSED, fully-scored 3-entrant round pinned as ONE shard, with shard 0's reveal already
   * "completed" and collected. Returns the entries byte-ascending, so `entries[0]` is the
   * grinded attacker and `entries[2]` is the true MPC rank-1.
   */
  async function bootstrap() {
    const h = await Harness.create();
    const authority = h.payer;
    await h.send(
      [await h.program.methods.initializeConfig().accountsStrict({
        authority: authority.publicKey, config: h.configPda(), systemProgram: h.systemProgram(),
      }).instruction()],
      [authority],
    );

    const [roundPda, roundBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("round"), u64le(1)], h.program.programId,
    );
    const roundData = await h.program.coder.accounts.encode("competitionRound", {
      roundId: new BN(1), status: ROUND_STATUS_CLOSED,
      startTime: new BN(1_700_000_000), endTime: new BN(1_700_086_400),
      maxParticipants: 221, participantCount: N, authority: authority.publicKey,
      bump: roundBump, targetTraits: [0, 0, 0, 0], targetTraitCount: 0,
      top1: PublicKey.default, top2: PublicKey.default, top3: PublicKey.default,
      scoringRevealed: false, scoredCount: N,
    });
    h.context.setAccount(roundPda, {
      lamports: 5_000_000, data: Buffer.from(roundData),
      owner: h.program.programId, executable: false, rentEpoch: 0,
    });

    const entries: PK[] = [];
    for (let i = 0; i < N; i++) {
      const key = Keypair.generate().publicKey;
      const data = await h.program.coder.accounts.encode("competitionEntry", {
        round: roundPda, player: Keypair.generate().publicKey, flowerRecord: PublicKey.default,
        submittedAt: new BN(1_700_000_000), status: 0, bump: 255,
        encryptedScore: Array.from(new Uint8Array(32)), scoreNonce: Array.from(new Uint8Array(16)),
        scored: true, scoreErrorCode: 0, scoreQueued: false, queuedAt: new BN(0),
        raritySnapshot: 0,
      });
      h.context.setAccount(key, {
        lamports: 5_000_000, data: Buffer.from(data),
        owner: h.program.programId, executable: false, rentEpoch: 0,
      });
      entries.push(key);
    }
    entries.sort(cmp);

    // ONE shard covering the whole round.
    const ZERO = PublicKey.default;
    let r = await h.send(
      [await h.program.methods.initBracket([N, 0, 0, 0], [entries[0], ZERO, ZERO, ZERO], 1).accountsPartial({
        authority: authority.publicKey, config: h.configPda(), round: roundPda,
        bracket: bracketPda(h, roundPda), systemProgram: h.systemProgram(),
      }).instruction()],
      [authority],
    );
    assert.isNull(r.result, `init_bracket failed: ${r.result}`);

    // Shard 0's reveal "completes" with the ranking DELIBERATELY inverted against pubkey order:
    // slot 2 (the last entry byte-wise) is rank 1; slot 0 (the attacker) is rank 3.
    const [resPda, resBump] = shardResPda(h, roundPda, 0);
    const resData = await h.program.coder.accounts.encode("revealTop3V3Result", {
      round: roundPda, ready: true, slot1: 2, slot2: 1, slot3: 0,
      score1: 9, score2: 8, score3: 7, errorCode: 0, bump: resBump, generation: 1,
    });
    h.context.setAccount(resPda, {
      lamports: 5_000_000, data: Buffer.from(resData),
      owner: h.program.programId, executable: false, rentEpoch: 0,
    });

    r = await h.send(
      [await h.program.methods.collectShardWinners(0).accountsPartial({
        authority: authority.publicKey, config: h.configPda(), round: roundPda,
        bracket: bracketPda(h, roundPda), result: resPda,
      }).remainingAccounts(entries.map((k) => ({ pubkey: k, isWritable: false, isSigner: false })))
        .instruction()],
      [authority],
    );
    assert.isNull(r.result, `collect_shard_winners failed: ${r.result}`);

    // Ground truth for everything below: collection stored RANK order, which here is the exact
    // REVERSE of pubkey order. If the two ever agreed the test would prove nothing.
    const b: any = await h.program.account.bracketState.fetch(bracketPda(h, roundPda));
    expect(b.shardCount, "one shard").to.equal(1);
    expect(b.finalistCount, "all three entrants are finalists").to.equal(3);
    expect(b.finalQueued, "no final reveal has run").to.equal(false);
    expect(b.finalists[0].toBase58(), "rank 1 is the entry that sorts LAST").to.equal(entries[2].toBase58());
    expect(b.finalists[2].toBase58(), "rank 3 is the attacker, who sorts FIRST").to.equal(entries[0].toBase58());

    return { h, authority, roundPda, entries, resPda };
  }

  /** Overwrite the bracket exactly as `queue_shard_reveal(FINAL)` would have: ascending + flag. */
  async function applyTheFinalRevealsRewrite(
    h: Harness, roundPda: PK, entries: PK[], finalQueued: boolean,
  ) {
    const pda = bracketPda(h, roundPda);
    const b: any = await h.program.account.bracketState.fetch(pda);
    const finalists = [...b.finalists];
    const ascending = [...entries].sort(cmp);           // what the handler validates and stores
    for (let i = 0; i < b.finalistCount; i++) finalists[i] = ascending[i];
    const data = await h.program.coder.accounts.encode("bracketState", {
      round: b.round, shardCount: b.shardCount, shardSizes: b.shardSizes,
      shardBounds: b.shardBounds, shardsCollected: b.shardsCollected,
      finalists, finalistCount: b.finalistCount,
      finalQueued, applied: b.applied, bump: b.bump, generation: b.generation,
    });
    h.context.setAccount(pda, {
      lamports: 5_000_000, data: Buffer.from(data),
      owner: h.program.programId, executable: false, rentEpoch: 0,
    });
  }

  it("THE DAMAGE: reordered finalists crown the pubkey-first entrant, who really placed third", async () => {
    const { h, authority, roundPda, entries, resPda } = await bootstrap();

    // The pre-fix read path: the array has been reordered, and nothing checks that it was.
    await applyTheFinalRevealsRewrite(h, roundPda, entries, /* finalQueued */ false);

    const r = await h.send(
      [await h.program.methods.applyBracketResult(0).accountsPartial({
        authority: authority.publicKey, config: h.configPda(), round: roundPda,
        bracket: bracketPda(h, roundPda), result: resPda,
      }).instruction()],
      [authority],
    );
    assert.isNull(r.result, `apply should still succeed on a merely-reordered bracket: ${r.result}`);

    const round: any = await h.program.account.competitionRound.fetch(roundPda);
    expect(round.top1.toBase58(), "the grinded, pubkey-first entrant takes first place").to.equal(entries[0].toBase58());
    expect(round.top3.toBase58(), "the true rank-1 is demoted to third").to.equal(entries[2].toBase58());
  });

  it("THE FIX: the state a real final reveal leaves behind is refused, so nobody is crowned", async () => {
    const { h, authority, roundPda, entries, resPda } = await bootstrap();

    // Exactly what `queue_shard_reveal(FINAL)` writes — the reorder AND the flag.
    await applyTheFinalRevealsRewrite(h, roundPda, entries, /* finalQueued */ true);

    const r = await h.send(
      [await h.program.methods.applyBracketResult(0).accountsPartial({
        authority: authority.publicKey, config: h.configPda(), round: roundPda,
        bracket: bracketPda(h, roundPda), result: resPda,
      }).instruction()],
      [authority],
    );
    assert.isNotNull(r.result, "applying a one-shard bracket that carries final_queued MUST be rejected");
    expect(JSON.stringify(r.result), "rejected specifically with FinalRevealNotApplicable (6079)")
      .to.contain(FINAL_REVEAL_NOT_APPLICABLE);

    const round: any = await h.program.account.competitionRound.fetch(roundPda);
    expect(round.scoringRevealed, "the round stays unrevealed").to.equal(false);
    expect(round.top1.toBase58(), "the attacker was NOT crowned").to.equal(PublicKey.default.toBase58());
  });

  it("THE HONEST PATH: an untouched one-shard bracket still crowns the MPC rank-1", async () => {
    const { h, authority, roundPda, entries, resPda } = await bootstrap();

    const r = await h.send(
      [await h.program.methods.applyBracketResult(0).accountsPartial({
        authority: authority.publicKey, config: h.configPda(), round: roundPda,
        bracket: bracketPda(h, roundPda), result: resPda,
      }).instruction()],
      [authority],
    );
    assert.isNull(r.result, `the ordinary single-shard endgame must still work: ${r.result}`);

    const round: any = await h.program.account.competitionRound.fetch(roundPda);
    expect(round.scoringRevealed, "round revealed").to.equal(true);
    expect(round.top1.toBase58(), "first place is the MPC rank-1, which sorts LAST").to.equal(entries[2].toBase58());
    expect(round.top2.toBase58(), "second place unchanged").to.equal(entries[1].toBase58());
    expect(round.top3.toBase58(), "the pubkey-first entrant stays third, where the MPC put them")
      .to.equal(entries[0].toBase58());
  });
});
