/**
 * Partition-planner tests for the auto-cycle bracket reveal (scripts/auto-cycle.ts).
 *
 * PURE — no chain, no keypair, no RPC. It imports the real planner out of auto-cycle.ts (which
 * only runs its cycle when it is the process entry point) and checks the partition it produces
 * against the rules `init_bracket` / `init_tier1_bracket` / `queue_shard_reveal` actually
 * enforce on-chain, for EVERY round size the program accepts (1..=221).
 *
 * This is the cheap half of proving the reveal migration: a partition the program would reject
 * costs a failed transaction mid-reveal to discover live, and only for the specific entry count
 * (or the specific ~1-in-256 pubkey) that triggers it. The live end-to-end run proves the
 * orchestration; this proves the arithmetic for all the sizes a live run cannot afford to visit.
 *
 *   npx mocha --no-config tests/auto-cycle-bracket.ts
 */
import { assert } from "chai";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import {
  compareEntryKeys,
  sortEntriesByteWise,
  planShardSizes,
  expectedTier1Winners,
  planBracket,
  padNumbers,
  padKeys,
  BracketPlanError,
  MAX_SHARD_SIZE,
  MAX_SHARDS,
  MAX_TIER1_SHARDS,
  SHARD_WINNERS,
  SINGLE_TIER_CAPACITY,
  TWO_TIER_CAPACITY,
  rpcRead,
  rpcBackoffMs,
  RPC_ATTEMPTS,
  getMultipleAccountsInfoChunked,
  GET_MULTIPLE_ACCOUNTS_LIMIT,
  fetchRoundEntryAccounts,
  settlementExists,
  settlementStateOf,
  owingRounds,
  classifyPotVaults,
  warnFinalizedOutsideCycle,
  SETTLEMENT_NONE,
  SETTLEMENT_POT_PAID,
  SETTLEMENT_POT_REFUNDED,
  reclaimThenOpen,
  reclaimFailureMessage,
  runNonBlocking,
  accountOwnedWithData,
  fetchProgramAccounts,
  ensureTokenAccounts,
  SPL_TOKEN_PROGRAM_ID,
  createBracketRevealer,
  rpcHost,
  stuckScoreAction,
  SCORE_TIMEOUT_SECONDS,
  SCORE_ATTEMPTS,
  lockAction,
  acquireLock,
  releaseLock,
  LOCK_PATH,
  LOCK_STALE_SECONDS,
  classifyScoreState,
} from "../scripts/auto-cycle.ts";

const { PublicKey, Keypair } = anchor.web3;
type PK = anchor.web3.PublicKey;

/** `n` distinct random entry addresses, in arbitrary (unsorted) order — as they arrive from
 *  getProgramAccounts, which does NOT return them ordered. */
const randomKeys = (n: number): PK[] =>
  Array.from({ length: n }, () => Keypair.generate().publicKey);

/** Raw byte-order comparison, independent of the implementation under test. */
function bytesLess(a: PK, b: PK): boolean {
  const x = a.toBytes();
  const y = b.toBytes();
  for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

describe("auto-cycle bracket partition planner", () => {
  describe("byte-wise ordering (the base58 trap)", () => {
    it("orders by raw bytes, not base58 text", () => {
      // A REAL pair (found by search) whose byte order and base58-TEXT order disagree.
      //
      // Base58 is a positional BIG-INTEGER encoding, not a byte-wise one, so its output has no
      // fixed width: `a`'s leading byte (8) makes it a smaller 256-bit number than `b`'s (31),
      // and it renders in 43 characters against `b`'s 44. Lexicographic string comparison then
      // compares 'a' (0x61) against '3' (0x33) and puts `b` first — the exact opposite of the
      // byte order Anchor's `Pubkey: Ord` uses. Sorting entries as text therefore produces a
      // partition the program rejects with ShardEntriesOutOfRange (6037), and only for the rare
      // rounds containing such a key, which is why it reads as intermittent rather than as a bug.
      const a = new PublicKey("aezSP94ezv94yVXNUS95wz4vtG8KCGhix3AW3v6jpGx");
      const b = new PublicKey("362MBm8XwLva4EnQc6SyCqzd89S8unhm8YKE3E4VpuFK");

      assert.equal(a.toBytes()[0], 8, "fixture `a`'s first byte");
      assert.equal(b.toBytes()[0], 31, "fixture `b`'s first byte — so `a` is first BY BYTES");
      assert.lengthOf(a.toBase58(), 43, "`a` renders in 43 chars");
      assert.lengthOf(b.toBase58(), 44, "`b` renders in 44 — the width difference is the trap");

      assert.isBelow(compareEntryKeys(a, b), 0, "by RAW BYTES `a` sorts first");
      assert.isAbove(a.toBase58().localeCompare(b.toBase58()), 0, "by base58 TEXT `a` sorts last");

      // The planner must follow the byte order.
      assert.deepEqual(
        sortEntriesByteWise([b, a]).map((k) => k.toBase58()), [a.toBase58(), b.toBase58()],
        "sortEntriesByteWise must put the leading-zero key first",
      );
      // …and that is genuinely different from what a naive text sort would produce.
      assert.deepEqual(
        [b, a].map((k) => k.toBase58()).sort(), [b.toBase58(), a.toBase58()],
        "sanity: a text sort orders the same pair the other way round",
      );
    });

    it("partitions a round containing a short-rendering key in byte order", () => {
      // End-to-end on the trap: a 22-entry round including the awkward key must still come out
      // strictly byte-ascending, with that key placed by its BYTES (first byte 8, so ahead of
      // all but ~3% of random keys) rather than by its text.
      const awkward = new PublicKey("aezSP94ezv94yVXNUS95wz4vtG8KCGhix3AW3v6jpGx");
      // Keys guaranteed to sort after it by bytes, so its expected position is unambiguous.
      const after = Array.from({ length: 21 }, () => {
        let k = Keypair.generate().publicKey;
        while (k.toBytes()[0] <= 8) k = Keypair.generate().publicKey;
        return k;
      });
      const plan = planBracket([...after, awkward]);

      const flat = plan.shards.flatMap((s) => s.entries);
      assert.equal(flat[0].toBase58(), awkward.toBase58(), "must sort to the front BY BYTES");
      for (let i = 1; i < flat.length; i++) {
        assert.isTrue(bytesLess(flat[i - 1], flat[i]), `not byte-ascending at ${i}`);
      }
      for (let k = 1; k < plan.shards.length; k++) {
        assert.isTrue(bytesLess(plan.shards[k - 1].bound, plan.shards[k].bound), "bounds must ascend");
      }
    });

    it("sortEntriesByteWise produces a strictly ascending sequence and does not mutate input", () => {
      const keys = randomKeys(50);
      const copy = [...keys];
      const sorted = sortEntriesByteWise(keys);
      assert.deepEqual(keys.map(String), copy.map(String), "input must not be mutated");
      for (let i = 1; i < sorted.length; i++) {
        assert.isTrue(bytesLess(sorted[i - 1], sorted[i]), `not ascending at ${i}`);
      }
    });
  });

  describe("planShardSizes", () => {
    it("balances rather than filling greedily", () => {
      // 53 must become [11,11,11,10,10], not [13,13,13,13,1] — a 1-entry shard wastes a whole
      // MPC call, and this is exactly the arithmetic promote_tier1 performs on-chain.
      assert.deepEqual(planShardSizes(53, MAX_SHARD_SIZE), [11, 11, 11, 10, 10]);
      assert.deepEqual(planShardSizes(13, MAX_SHARD_SIZE), [13]);
      assert.deepEqual(planShardSizes(14, MAX_SHARD_SIZE), [7, 7]);
      assert.deepEqual(planShardSizes(0, MAX_SHARD_SIZE), []);
    });

    it("never exceeds the max and always sums to n", () => {
      for (let n = 1; n <= TWO_TIER_CAPACITY; n++) {
        const sizes = planShardSizes(n, MAX_SHARD_SIZE);
        assert.equal(sizes.reduce((a, b) => a + b, 0), n, `sizes must sum to ${n}`);
        sizes.forEach((s) => {
          assert.isAtMost(s, MAX_SHARD_SIZE, `shard too big at n=${n}`);
          assert.isAtLeast(s, 1, `empty shard at n=${n}`);
        });
        // Balanced: the largest and smallest shard differ by at most one.
        assert.isAtMost(Math.max(...sizes) - Math.min(...sizes), 1, `unbalanced at n=${n}`);
      }
    });
  });

  describe("planBracket — every round size the program accepts", () => {
    // One pass over 1..221 checking every invariant the program verifies. Random keys each
    // iteration, so the byte-ordering path is exercised across many pubkey shapes.
    it("produces a program-valid partition for all sizes 1..221", () => {
      for (let n = 1; n <= TWO_TIER_CAPACITY; n++) {
        const plan = planBracket(randomKeys(n));

        assert.equal(plan.entryCount, n, `entryCount at n=${n}`);

        // --- sizes agree with the shards, and sum to the participant count ---
        assert.deepEqual(
          plan.sizes, plan.shards.map((s) => s.entries.length), `sizes/shards disagree at n=${n}`);
        assert.equal(
          plan.sizes.reduce((a, b) => a + b, 0), n, `sizes must sum to participantCount at n=${n}`);

        // --- tier selection matches the program's gate (init_tier1_bracket refuses <= 52) ---
        const expectTier = n > SINGLE_TIER_CAPACITY ? "two" : "single";
        assert.equal(plan.tier, expectTier, `wrong tier at n=${n}`);

        // --- shard count within the tier's limit ---
        const limit = plan.tier === "two" ? MAX_TIER1_SHARDS : MAX_SHARDS;
        assert.isAtMost(plan.shards.length, limit, `too many shards at n=${n}`);
        plan.shards.forEach((s, k) =>
          assert.isAtMost(s.entries.length, MAX_SHARD_SIZE, `shard ${k} too big at n=${n}`));

        // --- every shard's entries ascending, and the bound is its FIRST entry ---
        for (const [k, shard] of plan.shards.entries()) {
          assert.isAbove(shard.entries.length, 0, `empty shard ${k} at n=${n}`);
          assert.isTrue(shard.bound.equals(shard.entries[0]), `bound != first entry, shard ${k}, n=${n}`);
          for (let i = 1; i < shard.entries.length; i++) {
            assert.isTrue(
              bytesLess(shard.entries[i - 1], shard.entries[i]),
              `shard ${k} not ascending at n=${n}`);
          }
        }

        // --- shard bounds STRICTLY ascending (the program requires this) ---
        for (let k = 1; k < plan.shards.length; k++) {
          assert.isTrue(
            bytesLess(plan.shards[k - 1].bound, plan.shards[k].bound),
            `bounds not strictly ascending at shard ${k}, n=${n}`);
        }

        // --- shards partition the entry set: contiguous, disjoint, complete ---
        const flat = plan.shards.flatMap((s) => s.entries);
        assert.equal(new Set(flat.map((p) => p.toBase58())).size, n, `entries not disjoint at n=${n}`);
        for (let i = 1; i < flat.length; i++) {
          assert.isTrue(bytesLess(flat[i - 1], flat[i]), `shards not contiguous at n=${n}`);
        }

        // --- every entry lies inside its own shard's range (ShardEntriesOutOfRange guard) ---
        for (let k = 0; k < plan.shards.length; k++) {
          const nextBound = plan.shards[k + 1]?.bound;
          for (const e of plan.shards[k].entries) {
            assert.isFalse(bytesLess(e, plan.shards[k].bound), `entry below its bound, shard ${k}, n=${n}`);
            if (nextBound) {
              assert.isTrue(bytesLess(e, nextBound), `entry at/above next bound, shard ${k}, n=${n}`);
            }
          }
        }

        // --- finalReveal is skipped ONLY for a genuine single shard ---
        assert.equal(
          plan.finalReveal, !(plan.tier === "single" && plan.shards.length === 1),
          `finalReveal wrong at n=${n}`);

        // --- two-tier: promoted winners must fit the semifinal tier (52 slots) ---
        if (plan.tier === "two") {
          const promoted = expectedTier1Winners(plan.sizes);
          assert.isAtMost(
            promoted, MAX_SHARDS * MAX_SHARD_SIZE,
            `tier-1 promotes ${promoted} winners, past the semifinal tier's capacity, n=${n}`);
          assert.equal(
            plan.semifinalSizes.reduce((a, b) => a + b, 0), promoted,
            `semifinal sizes must account for every promoted winner at n=${n}`);
          assert.isAtMost(
            plan.semifinalSizes.length, MAX_SHARDS, `too many semifinals at n=${n}`);
          plan.semifinalSizes.forEach((s) =>
            assert.isAtMost(s, MAX_SHARD_SIZE, `semifinal too big at n=${n}`));
        } else {
          assert.deepEqual(plan.semifinalSizes, [], `single tier must have no semifinals at n=${n}`);
        }
      }
    });

    it("covers the sizes the OLD single-shot reveal could never handle", () => {
      // MAX_PARTICIPANTS = 16 was the old ceiling; round 50 drew 91. These are the sizes the
      // migration exists for.
      for (const n of [17, 22, 52, 53, 91, 221]) {
        const plan = planBracket(randomKeys(n));
        assert.equal(plan.entryCount, n);
        assert.equal(plan.sizes.reduce((a, b) => a + b, 0), n);
        assert.isTrue(plan.finalReveal, `n=${n} must need a final reveal`);
      }
      // The specific shapes, pinned so a constant drifting out of step with the program shows up.
      assert.deepEqual(planBracket(randomKeys(17)).sizes, [9, 8]);
      assert.deepEqual(planBracket(randomKeys(22)).sizes, [11, 11]);
      assert.deepEqual(planBracket(randomKeys(91)).sizes, [13, 13, 13, 13, 13, 13, 13]);
      assert.equal(planBracket(randomKeys(91)).tier, "two");
      assert.equal(planBracket(randomKeys(52)).tier, "single");
    });

    it("boundary: 52 is the last single-tier round, 53 the first two-tier one", () => {
      const single = planBracket(randomKeys(SINGLE_TIER_CAPACITY));
      assert.equal(single.tier, "single");
      assert.lengthOf(single.shards, MAX_SHARDS);
      assert.deepEqual(single.sizes, [13, 13, 13, 13]);

      const two = planBracket(randomKeys(SINGLE_TIER_CAPACITY + 1));
      assert.equal(two.tier, "two");
      assert.deepEqual(two.sizes, [11, 11, 11, 10, 10]);
    });

    it("a 13-entry round is one shard with no final reveal", () => {
      const plan = planBracket(randomKeys(MAX_SHARD_SIZE));
      assert.equal(plan.tier, "single");
      assert.lengthOf(plan.shards, 1);
      assert.isFalse(plan.finalReveal, "a single shard's ranking IS the round's ranking");
    });

    it("rejects an empty round and one past the 221 ceiling", () => {
      assert.throws(() => planBracket([]), BracketPlanError, /no entries/);
      assert.throws(
        () => planBracket(randomKeys(TWO_TIER_CAPACITY + 1)),
        BracketPlanError, /past the bracket's 221-entry ceiling/);
    });

    it("is order-independent: shuffled input yields the identical partition", () => {
      const keys = randomKeys(91);
      const a = planBracket(keys);
      const b = planBracket([...keys].reverse());
      assert.deepEqual(a.sizes, b.sizes);
      assert.deepEqual(
        a.shards.map((s) => s.bound.toBase58()),
        b.shards.map((s) => s.bound.toBase58()),
        "the partition must not depend on getProgramAccounts' arbitrary ordering",
      );
    });
  });

  describe("fixed-width instruction arguments", () => {
    it("pads sizes and bounds to the program's array width with zeroed tails", () => {
      const plan = planBracket(randomKeys(17)); // 2 shards, single tier
      const sizes = padNumbers(plan.sizes, MAX_SHARDS);
      const bounds = padKeys(plan.shards.map((s) => s.bound), MAX_SHARDS);

      assert.lengthOf(sizes, MAX_SHARDS);
      assert.lengthOf(bounds, MAX_SHARDS);
      assert.deepEqual(sizes, [9, 8, 0, 0]);
      assert.isTrue(bounds[0].equals(plan.shards[0].bound));
      assert.isTrue(bounds[1].equals(plan.shards[1].bound));
      bounds.slice(2).forEach((b, i) =>
        assert.isTrue(b.equals(PublicKey.default), `unused bound ${i + 2} must be zeroed`));
    });

    it("pads a two-tier plan to the 17-wide tier-1 arrays", () => {
      const plan = planBracket(randomKeys(91));
      const sizes = padNumbers(plan.sizes, MAX_TIER1_SHARDS);
      assert.lengthOf(sizes, MAX_TIER1_SHARDS);
      assert.deepEqual(sizes.slice(0, 7), [13, 13, 13, 13, 13, 13, 13]);
      assert.deepEqual(sizes.slice(7), new Array(MAX_TIER1_SHARDS - 7).fill(0));
    });
  });

  describe("getMultipleAccountsInfoChunked — the RPC's 100-key cap", () => {
    // The bug this guards: reclaimVaultRent reads rounds 1..current in one call, so from round
    // 101 on every cycle died with "Too many inputs provided; max 100" before open_round.
    /** A connection that enforces the real cap and tags each result with its own key. */
    function fakeConn() {
      const calls: number[] = [];
      const conn = {
        async getMultipleAccountsInfo(keys: PK[]) {
          calls.push(keys.length);
          if (keys.length > 100) throw new Error("Too many inputs provided; max 100");
          return keys.map((k, i) => (i % 3 === 0 ? null : { data: Buffer.from(k.toBytes()) }));
        },
      };
      return { conn: conn as unknown as anchor.web3.Connection, calls };
    }

    for (const n of [0, 1, 100, 101, 105, 250]) {
      it(`reads ${n} keys in batches of <=100, preserving order`, async () => {
        const keys = randomKeys(n);
        const { conn, calls } = fakeConn();
        const out = await getMultipleAccountsInfoChunked(conn, keys, "confirmed");
        assert.equal(GET_MULTIPLE_ACCOUNTS_LIMIT, 100);
        assert.lengthOf(out, n);
        assert.equal(calls.length, Math.ceil(n / 100));
        assert.isTrue(calls.every((c) => c <= 100));
        // Nulls are per-batch-position in the fake, so recompute where they fall.
        out.forEach((info, i) => {
          if ((i % 100) % 3 === 0) assert.isNull(info);
          else assert.isTrue(info!.data.equals(Buffer.from(keys[i].toBytes())), `index ${i} out of order`);
        });
      });
    }
  });

  describe("rpcRead — transient-failure retry on the opening reads", () => {
    // The bug this guards: a single `TypeError: fetch failed` on the cycle's first getBalance
    // aborted the whole run (observed live 2026-08-10). Unattended, that is a silently skipped
    // day. These use a real (tiny) backoff, so they exercise the actual sleep path.

    it("returns immediately when the read succeeds first time", async () => {
      let calls = 0;
      const out = await rpcRead("ok", async () => { calls++; return 42; });
      assert.equal(out, 42);
      assert.equal(calls, 1, "a healthy read must not retry");
    });

    it("retries a transient failure and returns the eventual success", async () => {
      let calls = 0;
      const out = await rpcRead("flaky", async () => {
        calls++;
        if (calls < 3) throw new TypeError("fetch failed");
        return "recovered";
      });
      assert.equal(out, "recovered");
      assert.equal(calls, 3, "must retry until it succeeds");
    });

    it("survives the exact live failure at the last possible attempt", async () => {
      let calls = 0;
      const out = await rpcRead("balance", async () => {
        calls++;
        if (calls < RPC_ATTEMPTS) {
          throw new TypeError(
            "failed to get balance of account 8L9SoH5Kw4DLw32vUQY4H3PMgkRL9mm9MLDT5z2QEbTd: TypeError: fetch failed");
        }
        return 12_280_413;
      });
      assert.equal(out, 12_280_413);
      assert.equal(calls, RPC_ATTEMPTS);
    });

    it("gives up after RPC_ATTEMPTS and names the read that failed", async () => {
      let calls = 0;
      try {
        await rpcRead("treasury balance", async () => { calls++; throw new Error("ETIMEDOUT"); });
        assert.fail("should have thrown");
      } catch (e) {
        assert.equal(calls, RPC_ATTEMPTS, "must stop at the attempt cap, not loop forever");
        assert.match((e as Error).message, /treasury balance failed after 6 attempts/);
        assert.include((e as Error).message, "ETIMEDOUT", "must preserve the underlying cause");
      }
    });

    it("uses the same capped exponential backoff as sendTxHttp", () => {
      // sendTxHttp: Math.min(6000, 500 * 2 ** (attempt - 1))
      assert.deepEqual(
        [1, 2, 3, 4, 5].map(rpcBackoffMs), [500, 1000, 2000, 4000, 6000],
        "backoff must match the send path, including the 6s cap");
    });
  });

  describe("stuck-computation recovery (cancel_stuck_score)", () => {
    // The bug this guards: devnet round 53 wedged at 47/53 on 2026-08-11 when Arcium stopped
    // serving our MXE. `queue_score_entry` carries
    // `constraint = !entry.score_queued @ ScoreAlreadyQueued`, so the entry stayed blocked and
    // every re-run aborted on it until an operator ran cancel_stuck_score BY HAND. These prove
    // the cycle now decides that for itself, and in the right order.
    const QUEUED_AT = 1_786_000_000;

    it("does nothing when no computation is in flight", () => {
      assert.deepEqual(
        stuckScoreAction({ scored: false, scoreQueued: false, queuedAt: 0 }, QUEUED_AT),
        { kind: "not-queued" });
    });

    it("a late callback beats a pending cancel, even long past the timeout", () => {
      // Cancelling a scored entry fails with EntryAlreadyScored, so `scored` MUST win. This is
      // the race that matters: the callback can land while we are sleeping out the window.
      assert.deepEqual(
        stuckScoreAction(
          { scored: true, scoreQueued: true, queuedAt: QUEUED_AT },
          QUEUED_AT + SCORE_TIMEOUT_SECONDS * 10),
        { kind: "scored" });
    });

    it("waits rather than cancelling before the on-chain window opens", () => {
      // Firing at our own 360s client timeout would just bounce off ScoreNotYetTimedOut.
      const a = stuckScoreAction(
        { scored: false, scoreQueued: true, queuedAt: QUEUED_AT }, QUEUED_AT + 360);
      assert.equal(a.kind, "wait");
      assert.equal((a as { kind: "wait"; seconds: number }).seconds, SCORE_TIMEOUT_SECONDS - 360 + 3);
    });

    it("cancels exactly at the timeout boundary, not one second early", () => {
      assert.equal(
        stuckScoreAction({ scored: false, scoreQueued: true, queuedAt: QUEUED_AT },
          QUEUED_AT + SCORE_TIMEOUT_SECONDS - 1).kind,
        "wait", "one second early must still wait");
      assert.equal(
        stuckScoreAction({ scored: false, scoreQueued: true, queuedAt: QUEUED_AT },
          QUEUED_AT + SCORE_TIMEOUT_SECONDS).kind,
        "cancel", "at the boundary the program allows the cancel");
    });

    it("reproduces round 53's entry: 2310s in flight -> cancel immediately", () => {
      assert.deepEqual(
        stuckScoreAction({ scored: false, scoreQueued: true, queuedAt: QUEUED_AT },
          QUEUED_AT + 2310),
        { kind: "cancel" });
    });

    it("always waits a positive, bounded time when it waits at all", () => {
      for (let age = 0; age < SCORE_TIMEOUT_SECONDS; age++) {
        const a = stuckScoreAction(
          { scored: false, scoreQueued: true, queuedAt: QUEUED_AT }, QUEUED_AT + age);
        assert.equal(a.kind, "wait", `age ${age} must wait`);
        const s = (a as { kind: "wait"; seconds: number }).seconds;
        assert.isAbove(s, 0, `age ${age}`);
        assert.isAtMost(s, SCORE_TIMEOUT_SECONDS + 3, `age ${age}`);
      }
    });

    it("drives a full stuck -> wait -> cancel -> requeue -> scored recovery", async () => {
      // Simulates the real loop against a fake chain, using the SAME decision function the
      // cycle uses. Attempt 1 hangs (mirroring round 53); the retry succeeds.
      let now = QUEUED_AT + 100;
      const entry = { scored: false, scoreQueued: true, queuedAt: QUEUED_AT };
      const log: string[] = [];
      let hangNext = true; // first queue hangs, second lands

      for (let attempt = 1; attempt <= SCORE_ATTEMPTS; attempt++) {
        // --- recovery phase ---
        for (;;) {
          const a = stuckScoreAction(entry, now);
          if (a.kind === "scored" || a.kind === "not-queued") break;
          if (a.kind === "cancel") {
            entry.scoreQueued = false; // what cancel_stuck_score does on-chain
            log.push(`cancel@${now - QUEUED_AT}s`);
            break;
          }
          now += a.seconds; // sleeping out the window
          log.push(`wait${a.seconds}`);
        }
        if (entry.scored) break;

        // --- queue phase ---
        entry.scoreQueued = true;
        entry.queuedAt = now;
        log.push(`queue@${now - QUEUED_AT}s`);
        if (hangNext) {
          hangNext = false;
          now += 360; // our client timeout expires with no callback
          log.push("timeout");
        } else {
          entry.scored = true;
          entry.scoreQueued = false;
          log.push("callback");
          break;
        }
      }

      assert.isTrue(entry.scored, "the entry must end up scored");
      assert.isFalse(entry.scoreQueued, "the in-flight flag must be clear at the end");
      assert.deepEqual(log, [
        "wait503",            // 600 - 100 + 3
        "cancel@603s",        // window open, clear the original stuck computation
        "queue@603s",         // attempt 1 re-queue
        "timeout",            // hangs again
        "wait243",            // 600 - 360 + 3 for the NEW queuedAt
        "cancel@1206s",
        "queue@1206s",        // attempt 2
        "callback",           // lands
      ]);
      assert.equal(log.filter((l) => l.startsWith("cancel")).length, 2,
        "each hung computation must be cleared before its retry");
    });

    it("gives up after SCORE_ATTEMPTS rather than looping forever", () => {
      // A genuinely dead cluster must not turn into an unbounded stall.
      let now = QUEUED_AT;
      const entry = { scored: false, scoreQueued: false, queuedAt: 0 };
      let queues = 0;
      for (let attempt = 1; attempt <= SCORE_ATTEMPTS; attempt++) {
        for (;;) {
          const a = stuckScoreAction(entry, now);
          if (a.kind === "cancel") { entry.scoreQueued = false; break; }
          if (a.kind === "wait") { now += a.seconds; continue; }
          break;
        }
        entry.scoreQueued = true;
        entry.queuedAt = now;
        queues++;
        now += 360; // never any callback
      }
      assert.equal(queues, SCORE_ATTEMPTS, "bounded number of MPC computations spent");
      assert.isFalse(entry.scored);
    });
  });

  describe("expectedTier1Winners", () => {
    it("counts min(3, size) per shard", () => {
      assert.equal(expectedTier1Winners([13, 13, 13]), 9);
      assert.equal(expectedTier1Winners([2, 1, 13]), 2 + 1 + SHARD_WINNERS);
    });
  });
});

/**
 * Single-instance lock (scripts/auto-cycle.ts).
 *
 * Two deploy-triggered runs each attempted close_round on round 54 on 2026-08-13, 2m06s apart,
 * with no lock of any kind in place; they serialised by luck. `lockAction` is the pure decision
 * and is tested exhaustively here; `acquireLock`/`releaseLock` are exercised against a real
 * file, since the property that matters — two runs cannot both hold it — lives in the atomic
 * create, not in the predicate.
 */
describe("auto-cycle single-instance lock", () => {
  const NOW = 1_786_600_000;

  const clearLock = () => { try { fs.unlinkSync(LOCK_PATH); } catch { /* not there */ } };
  const writeLock = (pid: number, startedAt: number) =>
    fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid, startedAt }));

  beforeEach(clearLock);
  afterEach(clearLock);

  describe("lockAction — the pure decision", () => {
    it("acquires when no lock is present", () => {
      assert.deepEqual(lockAction(null, NOW), { kind: "acquire" });
    });

    it("aborts when a lock is fresh — another run is live", () => {
      const a = lockAction({ pid: 4242, startedAt: NOW - 30 }, NOW);
      assert.equal(a.kind, "abort");
      assert.equal((a as { pid: number }).pid, 4242);
      assert.equal((a as { ageSeconds: number }).ageSeconds, 30);
    });

    it("still aborts just BEFORE the staleness threshold", () => {
      assert.equal(lockAction({ pid: 1, startedAt: NOW - (LOCK_STALE_SECONDS - 1) }, NOW).kind, "abort");
    });

    it("steals exactly AT the threshold, and beyond", () => {
      assert.equal(lockAction({ pid: 1, startedAt: NOW - LOCK_STALE_SECONDS }, NOW).kind, "steal");
      assert.equal(lockAction({ pid: 1, startedAt: NOW - LOCK_STALE_SECONDS * 10 }, NOW).kind, "steal");
    });

    it("treats a future-dated lock as HELD, not stale (clock skew must not steal)", () => {
      assert.equal(lockAction({ pid: 9, startedAt: NOW + 5_000 }, NOW).kind, "abort");
    });

    it("does not steal from a long-but-legitimate cycle", () => {
      // 53 entries scoring + one hung entry's recovery is ~48 min of honest waiting.
      assert.equal(lockAction({ pid: 7, startedAt: NOW - 45 * 60 }, NOW).kind, "abort");
    });
  });

  describe("acquireLock / releaseLock — against a real file", () => {
    it("acquires when clear, and writes this process's pid", () => {
      assert.isTrue(acquireLock(NOW));
      const written = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
      assert.equal(written.pid, process.pid);
      assert.equal(written.startedAt, NOW);
    });

    it("refuses when a fresh lock from another pid is held", () => {
      writeLock(process.pid + 1, NOW - 10);
      assert.isFalse(acquireLock(NOW));
      // the other run's lock must survive our refusal
      assert.equal(JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")).pid, process.pid + 1);
    });

    it("steals a stale lock and takes ownership", () => {
      writeLock(process.pid + 1, NOW - LOCK_STALE_SECONDS - 1);
      assert.isTrue(acquireLock(NOW));
      assert.equal(JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")).pid, process.pid);
    });

    it("treats a corrupt lock as ancient and steals it", () => {
      fs.writeFileSync(LOCK_PATH, "{ not json at all");
      assert.isTrue(acquireLock(NOW));
      assert.equal(JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")).pid, process.pid);
    });

    it("releases only OUR lock, leaving another run's untouched", () => {
      writeLock(process.pid + 1, NOW - 10);
      releaseLock();
      assert.isTrue(fs.existsSync(LOCK_PATH), "another run's lock must not be deleted");

      clearLock();
      assert.isTrue(acquireLock(NOW));
      releaseLock();
      assert.isFalse(fs.existsSync(LOCK_PATH), "our own lock must be removed");
    });

    it("release is safe when no lock exists", () => {
      assert.doesNotThrow(() => releaseLock());
    });

    it("a second acquire succeeds after the first releases (no stale block)", () => {
      assert.isTrue(acquireLock(NOW));
      releaseLock();
      assert.isTrue(acquireLock(NOW + 5), "a legitimate later run must not be blocked");
    });
  });

  // ---------------------------------------------------------------------------------------
  // classifyScoreState — the fix for the "abort reported as no-callback" monitoring bug.
  // Encodes the exact program semantics: `scored` is set ONLY by a successful callback; the
  // abort callback leaves scored=false and instead sets score_error_code + clears score_queued.
  // ---------------------------------------------------------------------------------------
  describe("classifyScoreState (score outcome detection)", () => {
    it("success: scored=true is 'scored' regardless of the other fields", () => {
      assert.equal(classifyScoreState({ scored: true, scoreQueued: false, scoreErrorCode: 0 }), "scored");
      // scored wins even if a stale error code lingers from a previous aborted attempt.
      assert.equal(classifyScoreState({ scored: true, scoreQueued: false, scoreErrorCode: 1 }), "scored");
    });

    it("abort: callback cleared score_queued, left scored=false with an error code", () => {
      // This is round 91's real state after each ProtocolRun abort: a callback LANDED (queued
      // is false) and it was a failure (error code 1) — the old code called this "no callback".
      assert.equal(classifyScoreState({ scored: false, scoreQueued: false, scoreErrorCode: 1 }), "aborted");
    });

    it("in-flight: still queued means no callback has landed yet", () => {
      assert.equal(classifyScoreState({ scored: false, scoreQueued: true, scoreErrorCode: 0 }), "in-flight");
    });

    it("in-flight is decided by score_queued, NOT by a stale error code", () => {
      // A fresh queue does not reset score_error_code, so a genuinely-in-flight computation can
      // carry a stale non-zero code from a prior attempt. It must still read as in-flight.
      assert.equal(classifyScoreState({ scored: false, scoreQueued: true, scoreErrorCode: 1 }), "in-flight");
    });

    it("cleared: not queued, not scored, no error => a cancel (never a callback outcome)", () => {
      // Only cancel_stuck_score produces this shape; a callback always sets scored or an error.
      assert.equal(classifyScoreState({ scored: false, scoreQueued: false, scoreErrorCode: 0 }), "cleared");
    });
  });
});

/**
 * The off-chain hardening after the round-101 halt: reclaim can no longer block open_round,
 * every settlement check agrees with close_pot_vault about what counts as a settlement, the
 * public-RPC getProgramAccounts retries like every other read, and the "finalized OUTSIDE
 * auto-cycle" warning fires only when something may still be owed. All against fake
 * connections and hand-built AccountInfos — no chain.
 */
describe("auto-cycle hardening (post round 101)", () => {
  const PROGRAM = Keypair.generate().publicKey;
  const SYSTEM = anchor.web3.SystemProgram.programId;
  const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

  const info = (owner: PK, data: Buffer, lamports = 1_000_000): anchor.web3.AccountInfo<Buffer> =>
    ({ owner, data, lamports, executable: false, rentEpoch: 0 });
  /** What a bare SOL transfer to a settlement PDA leaves behind: System-owned, no data. */
  const lamportOnly = () => info(SYSTEM, Buffer.alloc(0), 890_880);
  /** A real RoundSettlement (102 bytes) in `state`. */
  const settlement = (state: number) => {
    const d = Buffer.alloc(102);
    d[16] = state;
    return info(PROGRAM, d);
  };
  /** A CompetitionRound (174 bytes): `status` at 16, `participant_count` at 35. */
  const roundAcct = (status: number, participants: number) => {
    const d = Buffer.alloc(174);
    d[16] = status;
    d.writeUInt16LE(participants, 35);
    return info(PROGRAM, d);
  };
  const vault = () => info(TOKEN, Buffer.alloc(165), 2_039_280);
  const FINALIZED = 2;

  describe("settlementExists — matches close_pot_vault's data_is_empty()", () => {
    it("absent address → no settlement", () => {
      assert.isFalse(settlementExists(null, PROGRAM));
      assert.isFalse(settlementExists(undefined, PROGRAM));
    });
    it("lamport-only account (System-owned, empty data) → no settlement", () => {
      assert.isFalse(settlementExists(lamportOnly(), PROGRAM));
    });
    it("program-owned but empty → no settlement (data_is_empty is the program's test)", () => {
      assert.isFalse(settlementExists(info(PROGRAM, Buffer.alloc(0)), PROGRAM));
    });
    it("data owned by another program → no settlement", () => {
      assert.isFalse(settlementExists(info(SYSTEM, Buffer.alloc(102)), PROGRAM));
    });
    it("program-owned with data → a settlement, and its state is read from offset 16", () => {
      assert.isTrue(settlementExists(settlement(SETTLEMENT_POT_PAID), PROGRAM));
      assert.equal(settlementStateOf(settlement(SETTLEMENT_POT_PAID), PROGRAM), SETTLEMENT_POT_PAID);
      assert.equal(settlementStateOf(settlement(SETTLEMENT_POT_REFUNDED), PROGRAM), SETTLEMENT_POT_REFUNDED);
      assert.equal(settlementStateOf(settlement(1), PROGRAM), 1);
    });
  });

  describe("a lamport-only settlement is treated as ABSENT at every site", () => {
    it("settlementStateOf (step 4b's already-settled check, the close-step warning) → NONE", () => {
      assert.equal(settlementStateOf(lamportOnly(), PROGRAM), SETTLEMENT_NONE);
    });

    it("settleBacklog's owing list still includes the round", () => {
      // Before: `settles[i] === null`, so a dusted PDA hid an unpaid round from the backlog.
      const ids = [73, 74, 75];
      const owing = owingRounds(ids, [settlement(SETTLEMENT_POT_PAID), lamportOnly(), null], PROGRAM);
      assert.deepEqual(owing, [74, 75]);
    });

    it("reclaim still closes an empty FINALIZED round's vault", () => {
      // Before: neither closable shape matched (st was truthy, st.data[16] undefined), so the
      // vault was counted stranded on every run, forever.
      const out = classifyPotVaults(
        [100], [roundAcct(FINALIZED, 0)], [lamportOnly()], [vault()], PROGRAM);
      assert.deepEqual(out, { closable: [100], stranded: [] });
    });

    it("reclaim does NOT treat it as a terminal settlement on a round that took entries", () => {
      const out = classifyPotVaults(
        [101], [roundAcct(FINALIZED, 3)], [lamportOnly()], [vault()], PROGRAM);
      assert.deepEqual(out, { closable: [], stranded: [101] });
    });

    it("the finalized-outside warning treats the round as unsettled", () => {
      assert.isTrue(warnFinalizedOutsideCycle(3, settlementStateOf(lamportOnly(), PROGRAM)));
    });
  });

  describe("classifyPotVaults — unchanged behaviour for real accounts", () => {
    it("paid or refunded → closable; pending refund → stranded; no vault / no round → skipped", () => {
      const ids = [70, 71, 72, 73, 74, 75];
      const rounds = [roundAcct(FINALIZED, 5), roundAcct(FINALIZED, 5), roundAcct(FINALIZED, 5),
        roundAcct(FINALIZED, 5), null, roundAcct(0, 0)];
      const settles = [settlement(SETTLEMENT_POT_PAID), settlement(SETTLEMENT_POT_REFUNDED),
        settlement(1), null, null, null];
      const vaults = [vault(), vault(), vault(), null, vault(), vault()];
      const out = classifyPotVaults(ids, rounds, settles, vaults, PROGRAM);
      // 73: vault already closed. 74: round never existed. 75: OPEN and empty is not closable.
      assert.deepEqual(out, { closable: [70, 71], stranded: [72, 75] });
    });
    it("an unsettled round that took entries is stranded, not closed", () => {
      const out = classifyPotVaults([80], [roundAcct(FINALIZED, 2)], [null], [vault()], PROGRAM);
      assert.deepEqual(out, { closable: [], stranded: [80] });
    });
  });

  describe("reclaimThenOpen — reclaim can never stop open_round, but still fails the run", () => {
    /** Records the order steps ran in; `open` reports round 103 as opened. */
    const steps = (calls: string[], reclaim: () => Promise<void>, errors: Error[] = []) => ({
      reclaim,
      open: async () => { calls.push("open"); return 103; },
      finish: async () => { calls.push("summary"); },
      onReclaimError: (e: Error) => { calls.push("report"); errors.push(e); },
    });

    it("reclaim throws → reported, round opened, summary printed, THEN the run fails (exit non-zero)", async () => {
      const calls: string[] = [];
      const errors: Error[] = [];
      let runError: Error | null = null;
      try {
        await reclaimThenOpen(steps(calls, async () => {
          calls.push("reclaim");
          throw new Error("Too many inputs provided; max 100");
        }, errors));
      } catch (e) {
        runError = e as Error;
      }
      // The open and the summary both happen BEFORE the run is failed — nothing is blocked.
      assert.deepEqual(calls, ["reclaim", "report", "open", "summary"]);
      assert.lengthOf(errors, 1);
      assert.include(errors[0].message, "max 100");
      // main's catch turns this into `AUTO-CYCLE FAILED: …` and process.exit(1), which is what
      // Railway flags.
      assert.isNotNull(runError, "a failed reclaim must fail the run once the work is done");
      assert.equal(runError!.message, reclaimFailureMessage("Too many inputs provided; max 100", 103));
      assert.include(runError!.message, "Round 103 was opened regardless");
    });

    it("reclaim's RPC read failing every retry (the round-101 shape) → open still runs, then the run fails", async () => {
      // The real chunked reader against a connection that rejects every call: rpcRead exhausts
      // its attempts (real backoff), the throw escapes reclaim, and open must still happen.
      const conn = {
        async getMultipleAccountsInfo() { throw new Error("Too many inputs provided; max 100"); },
      } as unknown as anchor.web3.Connection;
      const calls: string[] = [];
      const errors: Error[] = [];
      const ids = Array.from({ length: 101 }, (_, i) => i + 1); // reclaim surveys 1..current
      let runError: Error | null = null;
      await reclaimThenOpen(steps(calls, async () => {
        await getMultipleAccountsInfoChunked(conn, randomKeys(101), "confirmed", "reclaim rounds", ids);
      }, errors)).catch((e) => { runError = e as Error; });
      assert.deepEqual(calls, ["report", "open", "summary"], "open_round must run after a failed reclaim");
      // The failing batch is named by the ROUNDS it held, not by key index — in the report and
      // in the error the run exits with.
      assert.match(errors[0].message, /reclaim rounds \(rounds 1\.\.100\) failed after 6 attempts/);
      assert.match((runError as Error | null)?.message ?? "",
        /^vault-rent reclaim failed \(reclaim rounds \(rounds 1\.\.100\) failed after 6 attempts/);
    });

    it("reclaim succeeds → open, summary, and the run ends cleanly (exit 0)", async () => {
      const calls: string[] = [];
      await reclaimThenOpen(steps(calls, async () => { calls.push("reclaim"); }));
      assert.deepEqual(calls, ["reclaim", "open", "summary"]);
    });

    it("a failure to OPEN still propagates at once — no summary, as before", async () => {
      const calls: string[] = [];
      try {
        await reclaimThenOpen({
          ...steps(calls, async () => { calls.push("reclaim"); }),
          open: async () => { throw new Error("openRound(103) failed"); },
        });
        assert.fail("should have thrown");
      } catch (e) {
        assert.include((e as Error).message, "openRound(103) failed");
      }
      assert.deepEqual(calls, ["reclaim"]);
    });

    it("reclaim AND open both fail → the open failure is what surfaces", async () => {
      const calls: string[] = [];
      try {
        await reclaimThenOpen({
          ...steps(calls, async () => { throw new Error("survey down"); }),
          open: async () => { throw new Error("openRound(103) failed"); },
        });
        assert.fail("should have thrown");
      } catch (e) {
        assert.include((e as Error).message, "openRound(103) failed");
      }
      assert.deepEqual(calls, ["report"]);
    });

    it("reclaimFailureMessage names the opened round, or none on a path that opens nothing", () => {
      assert.equal(reclaimFailureMessage("x", 103),
        "vault-rent reclaim failed (x). Round 103 was opened regardless and all other cycle work "
        + "completed; flagging the run for monitoring. The next run re-surveys every vault.");
      assert.equal(reclaimFailureMessage("x", null),
        "vault-rent reclaim failed (x). All other cycle work completed; flagging the run for "
        + "monitoring. The next run re-surveys every vault.");
    });

    it("runNonBlocking wraps a non-Error throw", async () => {
      let got: Error | null = null;
      await runNonBlocking(async () => { throw "boom"; }, (e) => { got = e; });
      assert.instanceOf(got, Error);
      assert.equal((got as Error | null)?.message, "boom");
    });
  });

  describe("getMultipleAccountsInfoChunked — per-batch retry", () => {
    it("a batch that fails transiently is retried alone and order is preserved", async () => {
      const keys = randomKeys(150);
      const calls: number[] = [];
      let failedOnce = false;
      const conn = {
        async getMultipleAccountsInfo(ks: PK[]) {
          calls.push(ks.length);
          if (ks.length === 50 && !failedOnce) { failedOnce = true; throw new TypeError("fetch failed"); }
          return ks.map((k) => ({ data: Buffer.from(k.toBytes()) }));
        },
      } as unknown as anchor.web3.Connection;
      const out = await getMultipleAccountsInfoChunked(conn, keys, "confirmed");
      assert.deepEqual(calls, [100, 50, 50], "only the failed second batch is re-read");
      out.forEach((inf, i) => assert.isTrue(inf!.data.equals(Buffer.from(keys[i].toBytes()))));
    });
  });

  describe("fetchRoundEntryAccounts — getProgramAccounts retries like every other read", () => {
    const disc = { offset: 0, bytes: "3yqxZ8ZMDHm" };

    it("fails transiently, then succeeds → the cycle continues with the entries", async () => {
      const round = Keypair.generate().publicKey;
      const entry = { pubkey: Keypair.generate().publicKey, account: info(PROGRAM, Buffer.alloc(8)) };
      const seen: any[] = [];
      let calls = 0;
      const conn = {
        async getProgramAccounts(programId: PK, config: any) {
          calls++;
          seen.push({ programId, config });
          if (calls === 1) throw new Error("429 Too Many Requests");
          return [entry];
        },
      } as unknown as anchor.web3.Connection;
      const out = await fetchRoundEntryAccounts(conn, PROGRAM, disc, round);
      assert.equal(calls, 2, "must retry the transient failure");
      assert.deepEqual(out as any, [entry]);
      // The filters are the load-bearing part (see entriesForRound): discriminator + round.
      assert.isTrue(seen[1].programId.equals(PROGRAM));
      assert.deepEqual(seen[1].config.filters, [
        { memcmp: { offset: 0, bytes: disc.bytes } },
        { memcmp: { offset: 8, bytes: round.toBase58() } },
      ]);
    });

    it("gives up after RPC_ATTEMPTS and names the round", async () => {
      const round = Keypair.generate().publicKey;
      let calls = 0;
      const conn = {
        async getProgramAccounts() { calls++; throw new TypeError("fetch failed"); },
      } as unknown as anchor.web3.Connection;
      try {
        await fetchRoundEntryAccounts(conn, PROGRAM, disc, round);
        assert.fail("should have thrown");
      } catch (e) {
        assert.equal(calls, RPC_ATTEMPTS);
        assert.match((e as Error).message, /^entries of round .+ failed after 6 attempts: fetch failed/);
      }
    });
  });

  describe("warnFinalizedOutsideCycle — only when something may still be owed", () => {
    it("FINALIZED round whose pot was paid (state 2) → no warning (the round-101 re-run)", () => {
      assert.isFalse(warnFinalizedOutsideCycle(1, SETTLEMENT_POT_PAID));
    });
    it("refunded (state 3) → no warning", () => {
      assert.isFalse(warnFinalizedOutsideCycle(52, SETTLEMENT_POT_REFUNDED));
    });
    it("took entries and has no settlement → warning (the round-50 case)", () => {
      assert.isTrue(warnFinalizedOutsideCycle(91, SETTLEMENT_NONE));
    });
    it("refund still in progress (state 1) → warning", () => {
      assert.isTrue(warnFinalizedOutsideCycle(4, 1));
    });
    it("no entrants → nothing could be owed → no warning", () => {
      assert.isFalse(warnFinalizedOutsideCycle(0, SETTLEMENT_NONE));
    });
  });

  describe("rpcHost — the startup log never prints a key", () => {
    it("Helius key in the query string is dropped", () => {
      const out = rpcHost("https://devnet.helius-rpc.com/?api-key=00000000-SECRET-0000");
      assert.equal(out, "devnet.helius-rpc.com");
      assert.notInclude(out, "SECRET");
    });
    it("key in the path and userinfo credentials are dropped; the port is kept", () => {
      assert.equal(rpcHost("https://solana-devnet.g.alchemy.com/v2/SECRETKEY"), "solana-devnet.g.alchemy.com");
      assert.equal(rpcHost("https://user:SECRET@rpc.example.com:8899/x"), "rpc.example.com:8899");
    });
    it("public devnet", () => {
      assert.equal(rpcHost("https://api.devnet.solana.com"), "api.devnet.solana.com");
    });
    it("an unparseable value never echoes itself", () => {
      assert.equal(rpcHost("not a url SECRET"), "(unparseable URL)");
    });
  });
});

/**
 * Audit 2026-10-01, M1: a SOL-only account planted at a reveal-result PDA made Anchor's
 * fetchMultiple throw "Invalid account discriminator" before anything was queued, so the cycle
 * died at REVEAL on every run. Same class at the other addresses an outsider can fund: pot-vault
 * and player-ATA existence checks. Plus the manual fallback (operator.ts) now runs this same
 * revealer, so its finalist order is the one tested here.
 */
describe("outsider-fundable addresses (audit M1) and the shared bracket revealer", () => {
  const idl = JSON.parse(fs.readFileSync(new URL("../target/idl/secret_garden.json", import.meta.url), "utf8"));
  const SYSTEM = anchor.web3.SystemProgram.programId;
  const acct = (owner: PK, data: Buffer, lamports = 1_000_000): anchor.web3.AccountInfo<Buffer> =>
    ({ owner, data, lamports, executable: false, rentEpoch: 0 });
  /** What one System transfer of the rent-exempt minimum leaves at any address. */
  const solOnly = () => acct(SYSTEM, Buffer.alloc(0), 650_240);

  /** An in-memory chain: accounts by address, served through the Connection methods the
   *  revealer and Anchor's account namespace call. */
  function fakeChain() {
    const accounts = new Map<string, anchor.web3.AccountInfo<Buffer>>();
    const get = (k: PK) => accounts.get(k.toBase58()) ?? null;
    const conn = {
      async getAccountInfo(k: PK) { return get(k); },
      async getAccountInfoAndContext(k: PK) { return { context: { slot: 1 }, value: get(k) }; },
      async getMultipleAccountsInfo(ks: PK[]) { return ks.map(get); },
      async getMultipleAccountsInfoAndContext(ks: PK[]) { return { context: { slot: 1 }, value: ks.map(get) }; },
    };
    return { accounts, get, set: (k: PK, a: anchor.web3.AccountInfo<Buffer>) => accounts.set(k.toBase58(), a),
      conn: conn as unknown as anchor.web3.Connection };
  }

  describe("accountOwnedWithData / fetchProgramAccounts", () => {
    const PROG = Keypair.generate().publicKey;
    it("only an account of the given owner with data counts", () => {
      assert.isFalse(accountOwnedWithData(null, PROG));
      assert.isFalse(accountOwnedWithData(solOnly(), PROG));
      assert.isFalse(accountOwnedWithData(acct(PROG, Buffer.alloc(0)), PROG));
      assert.isFalse(accountOwnedWithData(acct(SYSTEM, Buffer.alloc(8)), PROG));
      assert.isTrue(accountOwnedWithData(acct(PROG, Buffer.alloc(8)), PROG));
    });

    it("decodes only owned accounts with data; absent, SOL-only and foreign come back null, in order", async () => {
      const ch = fakeChain();
      const [a, b, c, d] = randomKeys(4);
      ch.set(a, solOnly());
      ch.set(b, acct(PROG, Buffer.from("real")));
      ch.set(d, acct(SYSTEM, Buffer.from("not ours")));
      const out = await fetchProgramAccounts(ch.conn, [a, b, c, d], PROG, (data) => data.toString(), "t");
      assert.deepEqual(out, [null, "real", null, null]);
    });

    it("an owned account that does not decode is a layout problem, and says so", async () => {
      const ch = fakeChain();
      const [a] = randomKeys(1);
      ch.set(a, acct(PROG, Buffer.from("x")));
      try {
        await fetchProgramAccounts(ch.conn, [a], PROG, () => { throw new Error("bad layout"); }, "reveal results");
        assert.fail("should have thrown");
      } catch (e) {
        assert.match((e as Error).message, /^reveal results: .+ does not decode \(bad layout\)/);
      }
    });
  });

  describe("ensureTokenAccounts — the ATA existence check behind every payout", () => {
    it("creates over a SOL-only address and a missing one, skips a real token account", async () => {
      const ch = fakeChain();
      const [solAta, realAta, missingAta] = randomKeys(3);
      ch.set(solAta, solOnly());
      ch.set(realAta, acct(SPL_TOKEN_PROGRAM_ID, Buffer.alloc(165), 2_039_280));
      const created: PK[] = [];
      await ensureTokenAccounts(ch.conn, [solAta, realAta, missingAta].map((ata) => ({ ata })),
        async (t) => { created.push(t.ata); });
      // Before: `if (await conn.getAccountInfo(ata)) continue;` skipped the SOL-only one, and the
      // payout that needed it then failed for every co-winner.
      assert.deepEqual(created.map(String), [solAta, missingAta].map(String));
    });
  });

  describe("classifyPotVaults — a SOL-only account at a closed vault's address is no vault", () => {
    it("is neither closed (a fee burnt every run) nor counted stranded", () => {
      const PROG = Keypair.generate().publicKey;
      const round = acct(PROG, (() => { const d = Buffer.alloc(174); d[16] = 2; return d; })());
      const paid = acct(PROG, (() => { const d = Buffer.alloc(102); d[16] = 2; return d; })());
      const out = classifyPotVaults([101, 102], [round, round], [paid, paid],
        [solOnly(), acct(SPL_TOKEN_PROGRAM_ID, Buffer.alloc(165))], PROG);
      assert.deepEqual(out, { closable: [102], stranded: [] });
    });
  });

  describe("createBracketRevealer — the reveal auto-cycle and operator.ts both run", () => {
    const D = PublicKey.default;
    /** A key whose first byte is `first`: lets the test control byte order exactly. */
    const keyWithFirstByte = (first: number, fill = 0x11) => {
      const b = new Uint8Array(32).fill(fill);
      b[0] = first;
      return new PublicKey(b);
    };
    /** `n` distinct keys that are the same on every run, so every order below is deterministic. */
    const fixedKeys = (tag: string, n: number) => Array.from({ length: n }, (_, i) =>
      new PublicKey(createHash("sha256").update(`${tag}:${i}`).digest()));
    const camel = (n: string) => n.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
    const arg = (data: any, name: string) => data[name] ?? data[camel(name)];
    const byBytes = (a: PK, b: PK) => Buffer.compare(a.toBuffer(), b.toBuffer());
    /** The fake MPC's ranking of every run: its 3rd, 1st and 2nd entries, deliberately NOT the
     *  run's byte order, so finalists are collected out of order and the final reveal has to
     *  re-sort them (a no-op sort would otherwise pass). */
    const RANKING = [2, 0, 1];

    /**
     * The production program, applied to the fake chain: just enough of every bracket
     * instruction, each callback landing at once, with the program's account-run checks
     * enforced — n entries per queue and per shard/tier-1 collect, none per semifinal collect
     * (lib.rs:1185-1188, 1352), strict byte ascent inside the pinned bounds, finalist and
     * semifinal-slice membership — so a run the program would reject throws here, as the
     * transaction would, instead of passing silently.
     */
    async function harness(keys: PK[]) {
      const ch = fakeChain();
      const program = new anchor.Program(idl, new anchor.AnchorProvider(
        ch.conn, new anchor.Wallet(Keypair.generate()), {})) as anchor.Program<any>;
      const P = program.programId;
      const accIndex = new Map<string, Map<string, number>>(idl.instructions.map((ix: any) =>
        [camel(ix.name), new Map<string, number>(ix.accounts.map((a: any, i: number) => [a.name, i]))]));
      const enc = (name: string, obj: any) => program.coder.accounts.encode(name, obj);
      const dec = (name: string, k: PK): any => program.coder.accounts.decode(name, ch.get(k)!.data);
      const put = async (k: PK, name: string, obj: any) => ch.set(k, acct(P, await enc(name, obj)));
      const sent: { label: string; name: string; remaining: PK[] }[] = [];

      const round = Keypair.generate().publicKey;
      await put(round, "competitionRound", {
        roundId: new BN(104), status: 1, startTime: new BN(0), endTime: new BN(0),
        maxParticipants: 0, participantCount: keys.length, authority: D, bump: 255,
        targetTraits: [0, 0, 0, 0], targetTraitCount: 0, top1: D, top2: D, top3: D,
        scoringRevealed: false, scoredCount: keys.length,
      });
      const isEntry = new Set(keys.map(String));

      const fail = (label: string, why: string): never => { throw new Error(`${label}: ${why}`); };
      const exactly = (remaining: PK[], n: number, label: string) => {
        if (remaining.length !== n) fail(label, `WrongEntryCount (${remaining.length} accounts, want ${n})`);
      };
      const ascending = (run: PK[], label: string) => run.forEach((k, i) => {
        if (!isEntry.has(k.toBase58())) fail(label, `${k.toBase58()} is not an entry of this round`);
        if (i > 0 && byBytes(run[i - 1], k) >= 0) fail(label, `ShardEntriesOutOfRange (entry ${i} does not ascend)`);
      });
      /** queue_shard_reveal / collect_shard_winners (and the tier-1 pair) on shard k. */
      const inShard = (run: PK[], bounds: PK[], count: number, k: number, label: string) => {
        ascending(run, label);
        if (!run[0].equals(bounds[k])) fail(label, `ShardEntriesOutOfRange (not at shard_bounds[${k}])`);
        if (k + 1 < count && byBytes(run[run.length - 1], bounds[k + 1]) >= 0) {
          fail(label, `ShardEntriesOutOfRange (past shard_bounds[${k + 1}])`);
        }
      };

      // Tier1State is zero-copy (bytemuck) and 2,258 bytes, past the 1,000-byte buffer Anchor's
      // coder encodes into, so it is written by hand: every field is u8-aligned, so no padding.
      const tier1Disc = Buffer.from(idl.accounts.find((a: any) => a.name === "Tier1State").discriminator);
      type T1 = { bounds: PK[]; winners: PK[]; sizes: number[]; done: number[]; count: number; promoted: number; gen: number };
      const writeTier1 = (k: PK, t: T1) => {
        const b = Buffer.alloc(8 + 2250);
        tier1Disc.copy(b, 0);
        round.toBuffer().copy(b, 8);
        for (let i = 0; i < 17; i++) (t.bounds[i] ?? D).toBuffer().copy(b, 8 + 32 + 32 * i);
        for (let i = 0; i < 51; i++) (t.winners[i] ?? D).toBuffer().copy(b, 8 + 576 + 32 * i);
        for (let i = 0; i < 17; i++) { b[8 + 2208 + i] = t.sizes[i] ?? 0; b[8 + 2225 + i] = t.done[i] ?? 0; }
        b[8 + 2242] = t.count; b[8 + 2243] = t.winners.length; b[8 + 2244] = t.promoted; b[8 + 2245] = 255;
        b.writeUInt32LE(t.gen, 8 + 2246);
        ch.set(k, acct(P, b));
      };
      const readTier1 = (k: PK): T1 => {
        const t = dec("tier1State", k);
        return { bounds: t.shardBounds, winners: t.winners.slice(0, t.winnerCount), sizes: t.shardSizes,
          done: t.shardDone, count: t.shardCount, promoted: t.promoted, gen: Buffer.from(t.generation).readUInt32LE(0) };
      };
      const newBracket = (bracket: PK, shardCount: number, shardSizes: number[], shardBounds: PK[]) => {
        const prev = ch.get(bracket)?.data.length ? dec("bracketState", bracket) : null;
        return put(bracket, "bracketState", {
          round, shardCount, shardSizes, shardBounds, shardsCollected: 0,
          finalists: Array(12).fill(D), finalistCount: 0, finalQueued: false,
          applied: false, bump: 255, generation: (prev?.generation ?? 0) + 1,
        });
      };
      /** The callback, landed: init_if_needed absorbs whatever sat at the result PDA (a planted
       *  SOL-only account included), and the result is ready, ranked per RANKING. */
      const land = (result: PK, generation: number, size: number) => {
        const slots = RANKING.filter((s) => s < size).concat([0, 1, 2]).slice(0, 3);
        return put(result, "revealTop3V3Result", {
          round, ready: true, slot1: slots[0], slot2: slots[1], slot3: slots[2], score1: 70, score2: 70,
          score3: 70, errorCode: 0, bump: 255, generation,
        });
      };
      const slotsOf = (r: any, size: number): number[] => [r.slot1, r.slot2, r.slot3].slice(0, Math.min(3, size));
      const appendFinalists = (b: any, won: PK[]) => {
        const finalists = [...b.finalists];
        won.forEach((w, i) => (finalists[b.finalistCount + i] = w));
        return { finalists, finalistCount: b.finalistCount + won.length };
      };

      async function sendTx(tx: anchor.web3.Transaction, label: string): Promise<string> {
        const ix = tx.instructions.find((i) => i.programId.equals(P))!;
        const { name: raw, data } = (program.coder.instruction as any).decode(ix.data);
        const name = camel(raw);
        const idx = accIndex.get(name)!;
        const keysOf = ix.keys.map((m) => m.pubkey);
        const at = (account: string) => keysOf[idx.get(account)!];
        const remaining = keysOf.slice(idx.size);
        sent.push({ label, name, remaining });

        if (name === "initBracket") {
          const sizes: number[] = arg(data, "shard_sizes");
          if (sizes.reduce((a, s) => a + s, 0) !== keys.length) fail(label, "InvalidShardLayout");
          await newBracket(at("bracket"), arg(data, "shard_count"), sizes, arg(data, "shard_bounds"));
        } else if (name === "queueShardReveal") {
          const b = dec("bracketState", at("bracket"));
          const k = arg(data, "shard_index");
          if (k === 255) {
            exactly(remaining, b.finalistCount, label);
            ascending(remaining, label);
            const recorded = b.finalists.slice(0, b.finalistCount).map(String);
            remaining.forEach((e) => { if (!recorded.includes(e.toBase58())) fail(label, "FinalistMismatch"); });
            await land(at("result"), b.generation, remaining.length);
            await put(at("bracket"), "bracketState", { ...b, finalQueued: true });
          } else {
            exactly(remaining, b.shardSizes[k], label);
            inShard(remaining, b.shardBounds, b.shardCount, k, label);
            await land(at("result"), b.generation, remaining.length);
          }
        } else if (name === "collectShardWinners") {
          const b = dec("bracketState", at("bracket"));
          const r = dec("revealTop3V3Result", at("result"));
          const k = arg(data, "shard_index");
          if (r.generation !== b.generation) fail(label, "StaleRevealResult");
          exactly(remaining, b.shardSizes[k], label);
          inShard(remaining, b.shardBounds, b.shardCount, k, label);
          const won = slotsOf(r, remaining.length).map((x) => remaining[x]);
          await put(at("bracket"), "bracketState", {
            ...b, ...appendFinalists(b, won), shardsCollected: b.shardsCollected | (1 << k),
          });
        } else if (name === "initTier1Bracket") {
          writeTier1(at("tier1"), { bounds: arg(data, "shard_bounds"), winners: [], sizes: arg(data, "shard_sizes"),
            done: [], count: arg(data, "shard_count"), promoted: 0, gen: 1 });
        } else if (name === "queueTier1ShardReveal") {
          const t = readTier1(at("tier1"));
          const k = arg(data, "shard_index");
          exactly(remaining, t.sizes[k], label);
          inShard(remaining, t.bounds, t.count, k, label);
          await land(at("result"), t.gen, remaining.length);
        } else if (name === "collectTier1Winners") {
          const t = readTier1(at("tier1"));
          const r = dec("revealTop3V3Result", at("result"));
          const k = arg(data, "shard_index");
          if (r.generation !== t.gen) fail(label, "StaleRevealResult");
          exactly(remaining, t.sizes[k], label);
          inShard(remaining, t.bounds, t.count, k, label);
          // insert_winner_sorted: Tier1State.winners stays in raw pubkey order.
          const winners = [...t.winners];
          for (const x of slotsOf(r, remaining.length)) {
            if (winners.some((w) => w.equals(remaining[x]))) fail(label, "Tier1WinnerRejected");
            winners.push(remaining[x]);
            winners.sort(byBytes);
          }
          const done = [...t.done];
          done[k] = 1;
          writeTier1(at("tier1"), { ...t, winners, done });
        } else if (name === "promoteTier1") {
          const t = readTier1(at("tier1"));
          if (t.promoted !== 0 || t.done.slice(0, t.count).some((x) => x !== 1)) fail(label, "Tier1NotReady");
          const n = t.winners.length;
          const count = Math.ceil(n / 13);
          const sizes = [0, 0, 0, 0];
          const bounds = [D, D, D, D];
          let cursor = 0;
          for (let i = 0; i < count; i++) {
            sizes[i] = Math.floor(n / count) + (i < n % count ? 1 : 0);
            bounds[i] = t.winners[cursor];
            cursor += sizes[i];
          }
          await newBracket(at("bracket"), count, sizes, bounds);
          writeTier1(at("tier1"), { ...t, promoted: 1 });
        } else if (name === "queueSemifinalReveal") {
          const t = readTier1(at("tier1"));
          const b = dec("bracketState", at("bracket"));
          const k = arg(data, "semi_index");
          if (t.promoted !== 1) fail(label, "SemifinalNotReady");
          exactly(remaining, b.shardSizes[k], label);
          const start = b.shardSizes.slice(0, k).reduce((a: number, x: number) => a + x, 0);
          remaining.forEach((e, i) => { if (!e.equals(t.winners[start + i])) fail(label, "SemifinalSliceMismatch"); });
          await land(at("result"), b.generation, remaining.length);
        } else if (name === "collectSemifinalWinners") {
          const t = readTier1(at("tier1"));
          const b = dec("bracketState", at("bracket"));
          const r = dec("revealTop3V3Result", at("result"));
          const k = arg(data, "semi_index");
          if (r.generation !== b.generation) fail(label, "StaleRevealResult");
          exactly(remaining, 0, label);
          const start = b.shardSizes.slice(0, k).reduce((a: number, x: number) => a + x, 0);
          const won = slotsOf(r, b.shardSizes[k]).map((x) => t.winners[start + x]);
          await put(at("bracket"), "bracketState", {
            ...b, ...appendFinalists(b, won), shardsCollected: b.shardsCollected | (1 << k),
          });
        } else if (name === "applyBracketResult") {
          const b = dec("bracketState", at("bracket"));
          const r = dec("revealTop3V3Result", at("result"));
          if ((arg(data, "result_index") === 0) !== (b.shardCount === 1)) fail(label, "wrong result index for this bracket");
          if (!r.ready || r.generation !== b.generation) fail(label, "StaleRevealResult");
          await put(at("bracket"), "bracketState", { ...b, applied: true });
          await put(round, "competitionRound", { ...dec("competitionRound", round), scoringRevealed: true });
        } else {
          fail(label, `${name} is not modelled by the fake chain`);
        }
        return `sig-${sent.length}`;
      }

      const revealer = createBracketRevealer({
        program: program as any, conn: ch.conn, authority: Keypair.generate().publicKey,
        configPda: Keypair.generate().publicKey, sendTx,
        freshOffset: () => new BN(7),
        queueAccsFor: () => ({
          computationAccount: Keypair.generate().publicKey, clusterAccount: Keypair.generate().publicKey,
          mxeAccount: Keypair.generate().publicKey, mempoolAccount: Keypair.generate().publicKey,
          executingPool: Keypair.generate().publicKey, compDefAccount: Keypair.generate().publicKey,
        }),
      });
      const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, P)[0];
      return {
        ch, program, revealer, sent, round, dec,
        bracketPda: pda(Buffer.from("bracket"), round.toBuffer()),
        tier1Pda: pda(Buffer.from("tier1"), round.toBuffer()),
        shardRes: (k: number) => pda(Buffer.from("shardres"), round.toBuffer(), Buffer.from([k])),
        semiRes: (k: number) => pda(Buffer.from("semires"), round.toBuffer(), Buffer.from([k])),
        revealed: () => dec("competitionRound", round).scoringRevealed as boolean,
      };
    }

    // 14 entries -> two shards of 7. Each shard's top three are its first three entries (ranked
    // per RANKING), so the six finalists are the keys below. Their byte order and base58 order
    // disagree because of the 0x05 and 0x0c keys: those render as 43 base58 characters and sort
    // late as text. The 0x00 key is NOT the trap — its base58 text begins with '1', the lowest
    // base58 character, so it sorts first both ways; it is here because a leading zero byte is
    // the case the old comments warned about.
    const finalistsByBytes = [0x00, 0x05, 0x0c, 0x3a, 0x80, 0xf0].map((f) => keyWithFirstByte(f));
    const entries = [
      ...finalistsByBytes.slice(0, 3), ...[0x10, 0x11, 0x12, 0x13].map((f) => keyWithFirstByte(f)),
      ...finalistsByBytes.slice(3), ...[0xf1, 0xf2, 0xf3, 0xf4].map((f) => keyWithFirstByte(f)),
    ];

    it("SOL-only accounts at both shard results, the final's and the bracket: the round still reveals", async () => {
      const h = await harness(entries);
      const planted = [h.shardRes(0), h.shardRes(1), h.shardRes(255), h.bracketPda];
      planted.forEach((k) => h.ch.set(k, solOnly()));

      // The bug, reproduced: Anchor's fetchMultiple decodes the planted account and throws.
      try {
        await (h.program.account as any).revealTop3V3Result.fetchMultiple([h.shardRes(0)]);
        assert.fail("fetchMultiple should have thrown on the SOL-only account");
      } catch (e) {
        assert.match((e as Error).message, /discriminator/i);
      }

      const plan = await h.revealer.runBracketReveal(h.round, [...entries].reverse(), 104);
      assert.equal(plan.shards.length, 2);
      assert.deepEqual(h.sent.map((t) => t.label), [
        "initBracket", "queueShardReveal[0]", "queueShardReveal[1]",
        "collectShardWinners[0]", "collectShardWinners[1]",
        "queueShardReveal[FINAL]", "applyBracketResult",
      ]);
      assert.isTrue(h.revealed(), "the round reveals");
      // The planted lamports were absorbed by the (fake) init_if_needed, not left to block.
      planted.forEach((k) => assert.isTrue(accountOwnedWithData(h.ch.get(k), h.program.programId)));
    });

    it("the final reveal's finalists go out in byte order, not collection order and not base58 text", async () => {
      const h = await harness(entries);
      await h.revealer.runBracketReveal(h.round, entries, 104);
      const collected = h.dec("bracketState", h.bracketPda).finalists.slice(0, 6).map(String);
      const final = h.sent.find((t) => t.label === "queueShardReveal[FINAL]")!;
      const got = final.remaining.map(String);
      assert.deepEqual(got, finalistsByBytes.map(String), "finalists must be in raw byte order");
      assert.notDeepEqual(collected, got, "collection order differs, so the final really re-sorts");
      const byBase58 = [...finalistsByBytes].sort((a, b) => (a.toBase58() < b.toBase58() ? -1 : 1)).map(String);
      assert.notDeepEqual(got, byBase58, "this set must actually separate byte order from base58 order");
      assert.equal(final.remaining[0].toBytes()[0], 0x00, "a leading zero byte sorts first");
      // Production takes exactly n entries per reveal queue and per shard collect — not
      // entries plus flowers, the other half of what broke operator.ts.
      h.sent.filter((t) => t.name === "queueShardReveal").forEach((t) =>
        assert.include([7, 6], t.remaining.length, `${t.label} passed ${t.remaining.length} accounts`));
      h.sent.filter((t) => t.name === "collectShardWinners").forEach((t) =>
        assert.equal(t.remaining.length, 7, `${t.label} passed ${t.remaining.length} accounts`));
    });

    it("two tiers: SOL-only accounts at tier-1, semifinal and final results and at Tier1State: the round still reveals", async () => {
      const keys = fixedKeys("two-tier", 53);
      const h = await harness(keys);
      const planted = [h.shardRes(0), h.shardRes(4), h.semiRes(0), h.semiRes(1), h.shardRes(255), h.tier1Pda];
      planted.forEach((k) => h.ch.set(k, solOnly()));

      const plan = await h.revealer.runBracketReveal(h.round, keys, 104);
      assert.equal(plan.tier, "two");
      assert.deepEqual(plan.sizes, [11, 11, 11, 10, 10]);
      const tier1 = [0, 1, 2, 3, 4];
      assert.deepEqual(h.sent.map((t) => t.label), [
        "initTier1Bracket",
        ...tier1.map((k) => `queueTier1ShardReveal[${k}]`),
        ...tier1.map((k) => `collectTier1Winners[${k}]`),
        "promoteTier1",
        "queueSemifinalReveal[0]", "queueSemifinalReveal[1]",
        "collectSemifinalWinners[0]", "collectSemifinalWinners[1]",
        "queueShardReveal[FINAL]", "applyBracketResult",
      ], "no closeTier1Bracket: the planted Tier1State is absent, not 'stale'");
      assert.isTrue(h.revealed(), "the round reveals");
      planted.forEach((k) => assert.isTrue(accountOwnedWithData(h.ch.get(k), h.program.programId)));
      // 15 tier-1 winners promote into semifinals of [8, 7]; every queue carries n accounts.
      const lengths = (n: string) => h.sent.filter((t) => t.name === n).map((t) => t.remaining.length);
      assert.deepEqual(lengths("queueTier1ShardReveal"), [11, 11, 11, 10, 10]);
      assert.deepEqual(lengths("collectTier1Winners"), [11, 11, 11, 10, 10]);
      assert.deepEqual(lengths("queueSemifinalReveal"), [8, 7]);
      assert.deepEqual(lengths("collectSemifinalWinners"), [0, 0]);
      assert.deepEqual(lengths("queueShardReveal"), [6]);
    });

    it("operator.ts reveals through this revealer and no longer carries its own copy", () => {
      const src = fs.readFileSync(new URL("../scripts/operator.ts", import.meta.url), "utf8");
      assert.match(src, /import \{ createBracketRevealer, fetchRoundEntryAccounts \} from "\.\/auto-cycle\.ts"/);
      assert.include(src, "revealer.runBracketReveal(");
      assert.notMatch(src, /toBase58\(\)\s*<\s*\w+\.toBase58\(\)/, "no base58 comparator sort");
      assert.notInclude(src, "metasWithFlowers", "no 2n entries+flowers remaining accounts");
      assert.notMatch(src, /\bplanShards\b|\bshardResPda\b/, "no undefined helpers");
      assert.notInclude(src, ".getProgramAccounts(", "the entry scan goes through fetchRoundEntryAccounts");
    });
  });
});
