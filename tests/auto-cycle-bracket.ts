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
import * as anchor from "@anchor-lang/core";
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
  stuckScoreAction,
  SCORE_TIMEOUT_SECONDS,
  SCORE_ATTEMPTS,
  lockAction,
  acquireLock,
  releaseLock,
  LOCK_PATH,
  LOCK_STALE_SECONDS,
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
});
