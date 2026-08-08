/**
 * Differential proof for the stale-MPC-result-reuse fix (security audit finding).
 *
 * Reproduces the audit's exploit sequence against the SINGLE-TIER bracket, in bankrun:
 *
 *   init_bracket(A)  ->  [shard-0 reveal completes: result ready, generation = 1]
 *                    ->  collect_shard_winners(0)              ... SUCCEEDS (gen matches)
 *   init_bracket(B)  (re-init, DIFFERENT partition, generation -> 2)
 *                    ->  collect_shard_winners(0) with the SAME stale result
 *                                                              ... now REJECTS: StaleRevealResult
 *
 * The ONLY difference between the succeeding and failing collect is the intervening re-init.
 * Before the fix, the second collect would have succeeded and smuggled a winner from a
 * different partition (one never ranked against its real shard-mates) into `finalists`.
 *
 * Arcium callbacks can't run under bankrun, so the "shard reveal completed" state (a ready
 * RevealTop3V3Result) is fabricated with setAccount — the established harness pattern.
 */
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { assert, expect } from "chai";
import { Harness } from "./harness.ts";

const { PublicKey, Keypair } = anchor.web3;
type PK = anchor.web3.PublicKey;

const STALE_REVEAL_RESULT = "0x17a3"; // 6051
const ROUND_STATUS_CLOSED = 1;
const N = 14; // forces a genuine multi-shard split [7,7]; > the old 14-entry ceiling boundary

function cmp(a: PK, b: PK): number {
  const x = a.toBytes(), y = b.toBytes();
  for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

describe("bracket generation guard (stale-result-reuse fix)", () => {
  async function bootstrap() {
    const h = await Harness.create();
    const authority = h.payer;
    await h.send(
      [
        await h.program.methods.initializeConfig().accountsStrict({
          authority: authority.publicKey,
          config: h.configPda(),
          systemProgram: h.systemProgram(),
        }).instruction(),
      ],
      [authority],
    );

    // Fabricate a CLOSED, fully-scored round 1.
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

    // Fabricate N scored entries at N distinct pubkeys, then byte-wise sort (program order).
    const entries: PK[] = [];
    for (let i = 0; i < N; i++) {
      const key = Keypair.generate().publicKey;
      const data = await h.program.coder.accounts.encode("competitionEntry", {
        round: roundPda, player: Keypair.generate().publicKey, flowerRecord: PublicKey.default,
        submittedAt: new BN(1_700_000_000), status: 0, bump: 255,
        encryptedScore: Array.from(new Uint8Array(32)), scoreNonce: Array.from(new Uint8Array(16)),
        scored: true, scoreErrorCode: 0, scoreQueued: false, queuedAt: new BN(0),
      });
      h.context.setAccount(key, {
        lamports: 5_000_000, data: Buffer.from(data),
        owner: h.program.programId, executable: false, rentEpoch: 0,
      });
      entries.push(key);
    }
    entries.sort(cmp);
    return { h, authority, roundPda, entries };
  }

  function u64le(n: number | bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
  const bracketPda = (h: Harness, round: PK) =>
    PublicKey.findProgramAddressSync([Buffer.from("bracket"), round.toBuffer()], h.program.programId)[0];
  const shardResPda = (h: Harness, round: PK, i: number) =>
    PublicKey.findProgramAddressSync([Buffer.from("shardres"), round.toBuffer(), Buffer.from([i])], h.program.programId);

  async function initBracket(h: Harness, auth: anchor.web3.Keypair, round: PK, sizes: number[], bounds: PK[]) {
    const ZERO = PublicKey.default;
    const sizeArr = [0, 0, 0, 0]; sizes.forEach((s, i) => (sizeArr[i] = s));
    const boundArr = [ZERO, ZERO, ZERO, ZERO]; bounds.forEach((b, i) => (boundArr[i] = b));
    return h.send(
      [await h.program.methods.initBracket(sizeArr, boundArr, sizes.length).accountsPartial({
        authority: auth.publicKey, config: h.configPda(), round,
        bracket: bracketPda(h, round), systemProgram: h.systemProgram(),
      }).instruction()],
      [auth],
    );
  }

  // Fabricate a "shard reveal completed" result at generation `gen`.
  async function fabricateShardResult(h: Harness, round: PK, shardIdx: number, gen: number, slots: number[]) {
    const [pda, bump] = shardResPda(h, round, shardIdx);
    const data = await h.program.coder.accounts.encode("revealTop3V3Result", {
      round, ready: true, slot1: slots[0], slot2: slots[1], slot3: slots[2],
      score1: 9, score2: 8, score3: 7, errorCode: 0, bump, generation: gen,
    });
    h.context.setAccount(pda, {
      lamports: 5_000_000, data: Buffer.from(data),
      owner: h.program.programId, executable: false, rentEpoch: 0,
    });
    return pda;
  }

  async function collectShard(h: Harness, auth: anchor.web3.Keypair, round: PK, shardIdx: number, shardEntries: PK[]) {
    const [result] = shardResPda(h, round, shardIdx);
    return h.send(
      [await h.program.methods.collectShardWinners(shardIdx).accountsPartial({
        authority: auth.publicKey, config: h.configPda(), round,
        bracket: bracketPda(h, round), result,
      }).remainingAccounts(shardEntries.map((k) => ({ pubkey: k, isWritable: false, isSigner: false }))).instruction()],
      [auth],
    );
  }

  it("collect SUCCEEDS at the matching generation, then REJECTS the same stale result after a re-init", async () => {
    const { h, authority, roundPda, entries } = await bootstrap();

    // --- init_bracket(A): partition [7,7], generation -> 1 ---
    let r = await initBracket(h, authority, roundPda, [7, 7], [entries[0], entries[7]]);
    assert.isNull(r.result, `init_bracket(A) failed: ${r.result}`);

    // shard-0 reveal "completed" under generation 1
    await fabricateShardResult(h, roundPda, 0, 1, [0, 1, 2]);

    // --- BASELINE: collect shard 0 under the matching generation -> SUCCEEDS ---
    r = await collectShard(h, authority, roundPda, 0, entries.slice(0, 7));
    assert.isNull(r.result, `baseline collect (gen 1==1) should succeed, got: ${r.result}`);
    // finalist_count should now be 3 (this shard's top-3 recorded)
    const afterCollect: any = await h.program.account.bracketState.fetch(bracketPda(h, roundPda));
    expect(afterCollect.finalistCount, "collect recorded this shard's 3 winners").to.equal(3);
    expect(afterCollect.generation, "bracket at generation 1").to.equal(1);

    // --- EXPLOIT: re-init with a DIFFERENT partition [8,6], generation -> 2 ---
    r = await initBracket(h, authority, roundPda, [8, 6], [entries[0], entries[8]]);
    assert.isNull(r.result, `re-init_bracket(B) failed: ${r.result}`);
    const afterReinit: any = await h.program.account.bracketState.fetch(bracketPda(h, roundPda));
    expect(afterReinit.generation, "re-init bumped generation to 2").to.equal(2);
    expect(afterReinit.shardsCollected, "re-init reset the collected bitmap").to.equal(0);

    // The stale result (still generation 1, still ready) is UNTOUCHED by re-init.
    const staleRes: any = await h.program.account.revealTop3V3Result.fetch(shardResPda(h, roundPda, 0)[0]);
    expect(staleRes.ready, "stale result still marked ready").to.equal(true);
    expect(staleRes.generation, "stale result still stamped generation 1").to.equal(1);

    // --- collect shard 0 again, reusing the stale result. Supply partition B's shard-0
    //     entries (0..8) so the ONLY thing wrong is the generation. Must now REJECT. ---
    r = await collectShard(h, authority, roundPda, 0, entries.slice(0, 8));
    assert.isNotNull(r.result, "post-re-init collect of a stale result MUST be rejected");
    expect(JSON.stringify(r.result), "rejected specifically with StaleRevealResult (6051)").to.contain(STALE_REVEAL_RESULT);

    // And the bracket must be untouched by the rejected attempt (no forged finalist).
    const afterAttack: any = await h.program.account.bracketState.fetch(bracketPda(h, roundPda));
    expect(afterAttack.finalistCount, "no finalist was smuggled in").to.equal(0);
    expect(afterAttack.shardsCollected, "no shard marked collected by the blocked call").to.equal(0);
  });
});
