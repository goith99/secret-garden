/**
 * Secret Garden — DAILY AUTO-CYCLE (Railway cron, DEVNET cluster 456).
 *
 * A single standalone Node script (NOT a mocha test) that runs the full daily round
 * cycle end-to-end, in order:
 *
 *   1. close_round   (skipped if the round is already closed/finalized)
 *   2. score         (auto-score every unscored CompetitionEntry)
 *   3. bracket reveal (partition -> shard reveals -> final reveal -> apply)
 *   3b. distribute   (pay the SOL prize pool from the Treasury to the top 3 winners)
 *   4. finalize_round
 *   5. open_round    (open the next round)
 *
 * REVEAL IS A BRACKET, NOT ONE CALL. `queue_reveal_top3` is retired from this script: Arcium
 * rejects a queue_computation referencing 15+ distinct accounts (error 6202), and the program
 * caps that path at MAX_PARTICIPANTS = 16 — so a real round (round 50 drew 91 entries) could
 * never be revealed by it. Every round now goes through the bracket, whose shape depends only
 * on the entry count:
 *
 *   <= 13    one shard; that shard's ranking IS the round's, so the final reveal is skipped
 *            and apply_bracket_result(0) reads its winners directly. 1 MPC call.
 *   14..52   a single tier of shards + a final reveal over their winners.
 *   53..221  a tier-1 of up to 17 shards whose winners are promoted into the ordinary
 *            single-tier bracket as semifinals, then the same final + apply.
 *
 * The planning + orchestration below is a PORT of the production frontend's
 * src/program/{bracket,reveal}.ts — the same code the Operator Panel and
 * scripts/live-reveal-round.mjs run, including byte-wise pubkey ordering and the explicit
 * compute-unit limit on every reveal queue. Ported rather than imported because this script is
 * deliberately standalone (Railway runs it with no access to the frontend repo).
 *
 * RESUMABILITY. Every bracket step is recorded on-chain (BracketState.shards_collected /
 * final_queued, Tier1State.shard_done / promoted, per-shard result PDAs' `ready` flag), so an
 * interrupted cycle is resumed by re-deriving what is already done and skipping it.
 *
 * It reuses the EXACT instruction-calling patterns proven in scripts/operator.ts
 * (HTTP send/confirm on Helius, public-RPC fallback for getProgramAccounts, the
 * queue-accounts helper, and the Supabase result write) but does NOT depend on it.
 *
 * KEYPAIRS: Railway has no persistent secret filesystem, so both keys come from env vars as
 * Solana-CLI JSON array strings (e.g. "[12,34,...]"). Each is parsed, written to its OWN 0600
 * temp file under /tmp ONLY, used to load the Keypair, and unlinked on exit. Keys are never
 * logged. The OPERATOR key signs the program instructions (cycle); the separate TREASURY key
 * signs only the prize transfers. They are never mixed into the same variable or file.
 *
 * PRIZE POOL: after a successful reveal_top3 and BEFORE finalize, the Treasury pays
 * 0.5 SOL to each of the rank 1 / 2 / 3 winner wallets. Transfers are sequential and
 * independent — one failure is logged for manual retry and does NOT stop the rest of the
 * cycle (close/score/reveal/finalize/open still complete).
 *
 * ENV VARS:
 *   OPERATOR_PRIVATE_KEY  (required) JSON array string of the operator's 64-byte secret key
 *   TREASURY_PRIVATE_KEY  (required) JSON array string of the treasury's 64-byte secret key
 *   HELIUS_RPC_URL        (required) RPC for transactions + single-account reads
 *   ARCIUM_CLUSTER_OFFSET (default 456)
 *   SUPABASE_URL          (optional) round-history write (same pattern as operator.ts)
 *   SUPABASE_SERVICE_KEY  (optional)
 *
 * Run locally (NEVER commit the keys):
 *   export OPERATOR_PRIVATE_KEY='[...]'
 *   export TREASURY_PRIVATE_KEY='[...]'
 *   export HELIUS_RPC_URL='https://...'
 *   export ARCIUM_CLUSTER_OFFSET=456
 *   node scripts/auto-cycle.ts        # Node 22 strips TS types natively
 */
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import * as arcium from "@arcium-hq/client";
import { randomBytes } from "crypto";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { SecretGarden } from "../target/types/secret_garden";

const { PublicKey, Keypair, Connection, LAMPORTS_PER_SOL } = anchor.web3;
type PK = anchor.web3.PublicKey;

// --- on-chain constants (programs/secret-garden/src/constants.rs) ---
const ROUND_STATUS_OPEN = 0;
const ROUND_STATUS_CLOSED = 1;
const ROUND_STATUS_FINALIZED = 2;
const ROUND_STATUS_NAME = ["OPEN", "CLOSED", "FINALIZED"];

// Minimum operator SOL balance required to attempt a cycle. Below this the script logs a
// top-up warning and exits WITHOUT running (a partial cycle from running out of fees mid-way
// is worse than skipping a day).
const MIN_BALANCE_SOL = 0.5;

// Prize pool: SOL paid from the Treasury to the rank 1/2/3 winners, in that order. Indexed
// by (rank - 1).
const PRIZE_SOL = [0.5, 0.5, 0.5];
// Minimum Treasury balance required before the cycle runs — at least one day's full prize
// pool (0.5 + 0.5 + 0.5 = 1.5 SOL), plus the same 0.1 SOL absolute headroom the previous
// 10-SOL-pool gate carried. Transfer fees come from that headroom (three transfers cost
// ~0.000015 SOL, so 0.1 is deliberately generous); a per-payout shortfall is caught and
// logged for retry.
const MIN_TREASURY_SOL = 1.6;

// The ONLY treasury this script may ever spend from — PRODUCTION's live wallet.
//
// WHY THIS EXISTS. The treasury key arrives at runtime through TREASURY_PRIVATE_KEY, and this
// script is byte-identical in the dev and production repos. Nothing else pins, names or checks
// which wallet that env var holds, so the two environments were separated only by whichever
// value happened to be exported in the invoking shell. This constant makes a cross-environment
// mixup impossible rather than merely unlikely — in BOTH directions: it equally refuses a dev
// key here, which would otherwise pay real winners from a test wallet and silently under-fund
// or fail the payout.
//
// If you are deliberately rotating the production treasury, change THIS value — do not remove
// the check.
const TREASURY_PUBKEY = "Dp9E6VLzcDM8gWuieJuGChBDsnEDWH71HiEXeYsgB9rJ";

// --- bracket-reveal constants (mirror programs/secret-garden/src/constants.rs) ----------
// Changing one here without changing it there produces a partition the program rejects.
/** Entries per shard. One under the measured 14-account reveal ceiling. */
const MAX_SHARD_SIZE = 13;
/** Winners taken from each shard — what makes the bracket exact under a strict total order. */
const SHARD_WINNERS = 3;
/** Shards in the single tier (also the semifinal tier of a two-tier round). */
const MAX_SHARDS = 4;
/** Tier-1 shards in a two-tier bracket. */
const MAX_TIER1_SHARDS = 17;
/** Largest round one tier can reveal: 4 * 13. Past this the two-tier path is REQUIRED. */
const SINGLE_TIER_CAPACITY = MAX_SHARDS * MAX_SHARD_SIZE; // 52
/** Largest round the two-tier bracket can reveal: 17 * 13. */
const TWO_TIER_CAPACITY = MAX_TIER1_SHARDS * MAX_SHARD_SIZE; // 221
/** `shard_index` reserved for the FINAL reveal's result record (shares the shardres namespace). */
const FINAL_SHARD_INDEX = 255;

/** How often a pending reveal result is re-read. */
const RESULT_POLL_MS = 3_000;
/** How long a batch of queued reveals may take before the run gives up (stuck, not slow). */
const RESULT_TIMEOUT_MS = 420_000;
/** On resume, how long to let an already-queued-but-not-ready result land before re-queueing. */
const RESUME_GRACE_MS = 90_000;

/** How long to wait for one scoring computation's callback before treating it as hung. */
const SCORE_FINALIZE_TIMEOUT_MS = 360_000;
/**
 * MIRRORS `SCORE_TIMEOUT_SECONDS` in programs/secret-garden/src/constants.rs.
 *
 * `cancel_stuck_score` refuses to clear an in-flight entry until this much time has elapsed
 * since `queued_at` (ScoreNotYetTimedOut), so a recovery attempt has to wait the remainder out
 * rather than firing as soon as our own client-side timeout expires.
 */
const SCORE_TIMEOUT_SECONDS = 600;
/**
 * Attempts per entry before the cycle gives up on it.
 *
 * Each attempt costs one MPC computation plus, on failure, up to SCORE_TIMEOUT_SECONDS of
 * waiting for the on-chain cancel window — so this is deliberately small. 3 covers a transient
 * hung computation without turning a genuinely dead cluster into an hours-long stall.
 */
const SCORE_ATTEMPTS = 3;

/** What stuck-score recovery should do next, decided purely from the entry's on-chain state. */
type StuckScoreAction =
  | { kind: "scored" }      // a late callback landed — never cancel, nothing to recover
  | { kind: "not-queued" }  // nothing in flight
  | { kind: "wait"; seconds: number } // in flight, but the on-chain cancel window is not open yet
  | { kind: "cancel" };     // in flight and timed out — clear it

/**
 * Decide the next recovery step for a possibly-hung scoring computation.
 *
 * Split out as a PURE function because the ordering is what matters and it is easy to get
 * wrong: a late callback must beat a pending cancel (cancelling a scored entry fails with
 * EntryAlreadyScored), and `cancel_stuck_score` refuses until SCORE_TIMEOUT_SECONDS has
 * elapsed (ScoreNotYetTimedOut) — so a client that fires as soon as its OWN shorter timeout
 * expires just bounces off the program. The +3s cushion absorbs clock skew between this
 * process and the validator.
 */
function stuckScoreAction(
  entry: { scored: boolean; scoreQueued: boolean; queuedAt: number },
  nowSecs: number,
): StuckScoreAction {
  if (entry.scored) return { kind: "scored" };
  if (!entry.scoreQueued) return { kind: "not-queued" };
  const age = nowSecs - entry.queuedAt;
  if (age >= SCORE_TIMEOUT_SECONDS) return { kind: "cancel" };
  return { kind: "wait", seconds: SCORE_TIMEOUT_SECONDS - age + 3 };
}

/** What the close stage should do, decided purely from round state + wall clock. */
type CloseAction =
  | { kind: "close" }                              // OPEN and its scheduled window has elapsed
  | { kind: "not-open" }                           // CLOSED/FINALIZED — later stages handle it
  | { kind: "too-early"; remainingSeconds: number }; // OPEN but still live — must NOT be closed

/**
 * Decide whether the round may be closed, from its status AND its scheduled end.
 *
 * STATUS ALONE IS NOT ENOUGH, and assuming it was is what this fixes. The close stage used to
 * be `if (status === OPEN) closeRound()`, which is only correct if the script runs exactly once
 * a day. It does not: `railway.json` sets `startCommand: npm run auto-cycle`, so EVERY deploy
 * runs a full cycle immediately. On 2026-08-13 two redeploys minutes after round 54 opened each
 * tried to close it ~5 minutes into its 24h window; both were rejected on-chain with 6032
 * RoundTooRecentToClose only because the cycle signs as an OPERATOR, and
 * `MIN_OPERATOR_CLOSE_DELAY_SECONDS` (1h) covered us. That guard is a backstop against a leaked
 * key, not a scheduler — it expires an hour in, and it does not apply at all when the signer is
 * the authority. So the script must decide this itself.
 *
 * Pure and exported so the boundary is unit-testable without a validator: closing a live round
 * early destroys it (0 entries, no winners, players locked out for the rest of the day), and
 * that is not a case to discover in production.
 */
function closeRoundAction(
  round: { status: number; endTime: number },
  nowSecs: number,
): CloseAction {
  if (round.status !== ROUND_STATUS_OPEN) return { kind: "not-open" };
  const remaining = round.endTime - nowSecs;
  // `>= end_time` closes; one second early is still early.
  if (remaining > 0) return { kind: "too-early", remainingSeconds: remaining };
  return { kind: "close" };
}

/** "23h 47m" / "47m 12s" / "12s" — for the skip message. */
function formatRemaining(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

// --- single-instance lock -------------------------------------------------------------------
//
// Nothing stopped two cycles running at once. On 2026-08-13 two deploy-triggered runs each
// attempted close_round on round 54, 2m06s apart — they serialised by luck, not design. A
// file lock in /tmp is the right scope: Railway runs one container, so per-container state is
// exactly the boundary we need, and no distributed lock is warranted.

/** Lock file. /tmp is per-container and is already where the temp keypairs live. */
const LOCK_PATH = path.join("/tmp", "secret-garden-auto-cycle.lock");

/**
 * How old a lock must be before it is presumed abandoned rather than held.
 *
 * DELIBERATELY GENEROUS. The obvious instinct is "a cycle takes a few minutes, so a few
 * minutes is plenty" — that is true of a quiet round and badly wrong of a busy one. Scoring is
 * one MPC computation per entry (round 53 had 53 of them), and a single hung entry costs up to
 * SCORE_ATTEMPTS x (SCORE_FINALIZE_TIMEOUT_MS + SCORE_TIMEOUT_SECONDS) ≈ 48 minutes of
 * legitimate waiting on its own. A short threshold would let a second run declare a healthy
 * long cycle "stale" and steal its lock — reintroducing exactly the race this prevents.
 *
 * One hour errs the safe way: runs are normally ~24h apart, so a crashed run blocking the next
 * one for an hour costs nothing, while stealing from a live run could double-submit
 * transactions.
 */
const LOCK_STALE_SECONDS = 3_600;

interface LockFile {
  pid: number;
  startedAt: number;
}

/** What to do about a lock we found. */
type LockAction =
  | { kind: "acquire" }                                  // nothing there — take it
  | { kind: "steal"; ageSeconds: number }                // abandoned — clear and take it
  | { kind: "abort"; ageSeconds: number; pid: number };  // live run holds it — stand down

/**
 * Decide from the lock's contents alone. Pure, so the boundary is unit-testable without
 * spawning processes — the same reason `stuckScoreAction` and `closeRoundAction` are pure.
 *
 * A lock whose timestamp is in the FUTURE (clock skew, or a corrupt file read as startedAt 0's
 * opposite) yields a negative age and is treated as held, not stale: refusing to run is always
 * recoverable, stealing from a live run is not.
 */
function lockAction(existing: LockFile | null, nowSecs: number): LockAction {
  if (!existing) return { kind: "acquire" };
  const age = nowSecs - existing.startedAt;
  if (age >= LOCK_STALE_SECONDS) return { kind: "steal", ageSeconds: age };
  return { kind: "abort", ageSeconds: age, pid: existing.pid };
}

/**
 * Take the lock, or report that another run holds it.
 *
 * Uses `open(..., "wx")` — create-exclusively — which is ATOMIC at the filesystem level, so two
 * runs starting in the same instant cannot both believe they won. Only when that fails with
 * EEXIST do we look at the existing lock and decide. A corrupt or unreadable lock is treated as
 * ancient (startedAt 0) and stolen: it cannot represent a live run's honest state.
 */
function acquireLock(nowSecs: number = Math.floor(Date.now() / 1000)): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_PATH, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: nowSecs }));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }

    let existing: LockFile;
    try {
      const raw = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
      existing = typeof raw?.startedAt === "number"
        ? { pid: Number(raw.pid) || 0, startedAt: raw.startedAt }
        : { pid: 0, startedAt: 0 };
    } catch {
      existing = { pid: 0, startedAt: 0 }; // unreadable → ancient → steal
    }

    const action = lockAction(existing, nowSecs);
    if (action.kind === "abort") {
      console.log(
        `\n↪ another auto-cycle run appears to be in progress ` +
        `(pid ${action.pid}, started ${formatRemaining(action.ageSeconds)} ago) — exiting.`,
      );
      return false;
    }
    if (action.kind === "steal") {
      console.log(
        `  (clearing a stale lock — ${formatRemaining(action.ageSeconds)} old, past the ` +
        `${formatRemaining(LOCK_STALE_SECONDS)} threshold; a previous run exited without cleanup)`,
      );
      try { fs.unlinkSync(LOCK_PATH); } catch { /* another run cleared it first */ }
    }
    // `acquire` cannot arise here — we only reach this branch on EEXIST, so a lock existed.
    // Looping to retry the atomic create is the correct response either way.
    // Loop once more: if a third run won the re-create race, its lock is fresh and we abort.
  }
  console.log(`\n↪ another auto-cycle run took the lock while this one cleared a stale one — exiting.`);
  return false;
}

/** Release the lock, but ONLY if it is ours — never delete a lock another run now holds. */
function releaseLock(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
    if (Number(raw?.pid) !== process.pid) return;
  } catch {
    return; // already gone, or not ours to reason about
  }
  try { fs.unlinkSync(LOCK_PATH); } catch { /* already gone */ }
}

/**
 * Explicit compute ceiling for a reveal queue. Solana grants 200,000 CU when a tx carries no
 * ComputeBudget instruction, and a 13-entry `queue_shard_reveal` was measured at 158,914 CU on
 * devnet — only 20% headroom. 250,000 restores a ~57% margin for ~40 bytes of transaction.
 * Requesting a limit does not spend it, and no CU price is set, so there is no priority fee.
 */
const REVEAL_CU_LIMIT = 250_000;

// Each key is materialized here (under /tmp ONLY — never the project dir) and removed on
// exit. 0600 so only the process owner can read it. The operator key (cycle signer) and the
// treasury key (prize payer) are kept in SEPARATE files and SEPARATE variables.
const OPERATOR_KEYPAIR_PATH = path.join("/tmp", "operator-keypair.json");
const TREASURY_KEYPAIR_PATH = path.join("/tmp", "treasury-keypair.json");

// Remove BOTH temp keys AND the single-instance lock on ANY exit — including the early
// process.exit() paths (low balance, fatal validation) that never reach main()'s catch, and
// the too-early close skip that returns before the cycle body. Registering the release here
// rather than in a try/finally around main() is deliberate: this fires for every one of those
// exits, so no path can leave a lock behind that would block the next legitimate run.
// Synchronous, best-effort. (SIGKILL is the one case nothing can clean up — that is precisely
// what LOCK_STALE_SECONDS exists for.)
process.on("exit", () => {
  for (const p of [OPERATOR_KEYPAIR_PATH, TREASURY_KEYPAIR_PATH]) {
    try { fs.unlinkSync(p); } catch { /* never written, or already gone */ }
  }
  releaseLock();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const u64le = (n: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const short = (pk: PK | string) => {
  const s = typeof pk === "string" ? pk : pk.toBase58();
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
};
/**
 * The git revision this process is actually running, logged at startup.
 *
 * WHY IT MATTERS. Railway builds from the GitHub default branch, so the code running here can
 * be older than the working tree it was written in. Production round 57 stalled for exactly
 * that reason: the reveal fix was committed locally but never pushed, Railway kept building
 * the previous revision, and the logs gave no way to tell which code was live. Printing the
 * revision makes that class of failure legible from the log alone.
 *
 * Railway injects RAILWAY_GIT_COMMIT_SHA, which is authoritative for what it built; git is the
 * fallback for local runs. Neither is guaranteed (the container has no .git), so this never
 * throws — an unknown revision is a logging gap, not a reason to refuse to run.
 */
function runningRevision(): string {
  const fromRailway = process.env.RAILWAY_GIT_COMMIT_SHA;
  if (fromRailway && fromRailway.trim() !== "") return `${fromRailway.trim().slice(0, 12)} (RAILWAY_GIT_COMMIT_SHA)`;
  try {
    // Static import, not require(): this package is "type": "module", so require is not
    // defined here and the git fallback would silently never fire.
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return `${sha.trim().slice(0, 12)} (git rev-parse HEAD)`;
  } catch {
    return "unknown (no RAILWAY_GIT_COMMIT_SHA and no usable git)";
  }
}

const fatal = (msg: string): never => {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
};

/** Attempts and backoff shared by `sendTxHttp` and `rpcRead`, so a transient RPC failure is
 *  treated the same whether it hits a send or a read. */
const RPC_ATTEMPTS = 6;
const rpcBackoffMs = (attempt: number) => Math.min(6000, 500 * 2 ** (attempt - 1));

/**
 * Retry a transient RPC READ, matching `sendTxHttp`'s retry pattern exactly (6 attempts, the
 * same capped exponential backoff).
 *
 * The cycle's opening reads had NO retry: a single blip aborted the whole run before any work
 * started. Observed live on 2026-08-10 —
 *   `AUTO-CYCLE FAILED: failed to get balance of account 8L9S...: TypeError: fetch failed`
 * on the very first call. That fails SAFE (nothing on-chain has changed yet), but for an
 * UNATTENDED cron it means a silently skipped day, which is exactly the outcome the balance
 * gates exist to prevent. Reads are idempotent, so retrying one is always safe.
 *
 * Exported for tests.
 */
async function rpcRead<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= RPC_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = (e as Error).message.slice(0, 90);
      if (attempt === RPC_ATTEMPTS) {
        throw new Error(`${label} failed after ${RPC_ATTEMPTS} attempts: ${msg}`);
      }
      console.log(`    ${label} read err (attempt ${attempt}/${RPC_ATTEMPTS}): ${msg}`);
      await sleep(rpcBackoffMs(attempt));
    }
  }
  throw new Error(`${label}: unreachable`); // for the type checker
}

/**
 * Parse a Solana-CLI JSON-array secret key from `envVar`, write it to a 0600 temp file at
 * `tmpPath` (under /tmp ONLY), and load the Keypair FROM that file path. Exits immediately on
 * any problem. The key material itself is never logged. Used independently for the operator
 * key and the treasury key — each gets its own env var, temp file, and returned variable.
 */
function loadKeypairFromEnv(envVar: string, tmpPath: string): anchor.web3.Keypair {
  const raw = process.env[envVar];
  if (!raw || raw.trim() === "") {
    fatal(`${envVar} is not set. Provide the wallet's secret key as a JSON array string.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw!);
  } catch {
    fatal(`${envVar} is not valid JSON. Expected a JSON array like "[12,34,...]".`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    !parsed.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255)
  ) {
    fatal(`${envVar} must be a JSON array of 64 byte values (0-255) — the Solana CLI keypair format.`);
  }
  const secret = parsed as number[];

  // Write to /tmp (0600) and load the Keypair from that path, per the Railway secret model.
  fs.writeFileSync(tmpPath, JSON.stringify(secret), { mode: 0o600 });
  let kp: anchor.web3.Keypair;
  try {
    kp = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(tmpPath).toString())),
    );
  } catch {
    fatal(`Failed to construct a Keypair from ${envVar} (not a valid 64-byte secret key).`);
  }
  return kp!;
}

// --- bracket PLANNING (pure, chain-free; port of the frontend's src/program/bracket.ts) ---
// The partition is the CLIENT's job — the program only VERIFIES it (strictly ascending shard
// bounds, sizes summing to participant_count, every supplied entry inside its shard's range).

/**
 * Compare two entry addresses the way the PROGRAM does — as raw [u8; 32], byte by byte.
 *
 * NOT `a.toBase58() < b.toBase58()`. Base58 drops leading zero bytes, so a key beginning 0x00
 * renders as a 43-character string that sorts LAST as text while sorting FIRST as bytes.
 * Anchor's `Pubkey: Ord` is the byte order, so a base58-text sort silently produces a partition
 * the program rejects with ShardEntriesOutOfRange (6037) — and only for the ~1-in-256 rounds
 * that contain such a key, which is why it reads as an intermittent failure rather than a bug.
 */
function compareEntryKeys(a: PK, b: PK): number {
  const x = a.toBytes();
  const y = b.toBytes();
  for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** A copy of `keys` in the program's canonical ascending order. Does not mutate the input. */
const sortEntriesByteWise = (keys: PK[]): PK[] => [...keys].sort(compareEntryKeys);

/**
 * Split `n` items into the fewest shards of at most `max`, balanced as evenly as possible —
 * the same arithmetic `promote_tier1` performs on-chain. Balanced rather than greedy-full
 * matters: 53 entries become [11,11,11,10,10], not [13,13,13,13,1] (a trailing 1-entry shard
 * is legal but spends a whole MPC call to rank a single flower).
 */
function planShardSizes(n: number, max: number = MAX_SHARD_SIZE): number[] {
  if (n <= 0) return [];
  const count = Math.max(1, Math.ceil(n / max));
  const base = Math.floor(n / count);
  const extra = n % count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

/** How many winners a tier-1 layout produces: every shard yields min(3, size) of them. */
const expectedTier1Winners = (sizes: number[]) =>
  sizes.reduce((sum, s) => sum + Math.min(SHARD_WINNERS, s), 0);

interface ShardPlan {
  /** The shard's entry addresses, ascending by raw pubkey bytes. */
  entries: PK[];
  /** The shard's FIRST entry — recorded on-chain as shard_bounds[k]. */
  bound: PK;
}

interface BracketPlan {
  tier: "single" | "two";
  entryCount: number;
  /** Tier-1 shards for a two-tier round; the only tier of shards otherwise. */
  shards: ShardPlan[];
  sizes: number[];
  /** False only for a single-shard round: that shard's ranking IS the round's ranking. */
  finalReveal: boolean;
  /** Semifinal sizes a two-tier round promotes into (authoritative copy is written on-chain). */
  semifinalSizes: number[];
}

class BracketPlanError extends Error {}

/**
 * Partition a round's entries into the bracket the program will accept. `entries` may arrive
 * in any order — it is sorted here, so callers cannot forget to.
 */
function planBracket(entries: PK[]): BracketPlan {
  const sorted = sortEntriesByteWise(entries);
  const n = sorted.length;
  if (n === 0) throw new BracketPlanError("this round has no entries to reveal");
  if (n > TWO_TIER_CAPACITY) {
    throw new BracketPlanError(`${n} entries is past the bracket's ${TWO_TIER_CAPACITY}-entry ceiling`);
  }

  const tier = n > SINGLE_TIER_CAPACITY ? "two" : "single";
  const sizes = planShardSizes(n, MAX_SHARD_SIZE);
  const limit = tier === "two" ? MAX_TIER1_SHARDS : MAX_SHARDS;
  if (sizes.length > limit) {
    // Unreachable given the ceiling above; kept so a constant edited out of step with the
    // program breaks here rather than as a rejected transaction.
    throw new BracketPlanError(`${n} entries needs ${sizes.length} shards, past the ${limit} allowed`);
  }

  const shards: ShardPlan[] = [];
  let cursor = 0;
  for (const size of sizes) {
    const chunk = sorted.slice(cursor, cursor + size);
    shards.push({ entries: chunk, bound: chunk[0] });
    cursor += size;
  }

  return {
    tier,
    entryCount: n,
    shards,
    sizes,
    finalReveal: tier === "two" || shards.length > 1,
    semifinalSizes: tier === "two" ? planShardSizes(expectedTier1Winners(sizes), MAX_SHARD_SIZE) : [],
  };
}

/** One-line human summary of the plan, for the cycle log. */
function describePlan(plan: BracketPlan): string {
  const sizes = `[${plan.sizes.join(", ")}]`;
  if (plan.tier === "single") {
    return plan.shards.length === 1
      ? `${plan.entryCount} entries fit one shard ${sizes} — a single reveal, no final round.`
      : `${plan.entryCount} entries → ${plan.shards.length} shards ${sizes} → final reveal.`;
  }
  return `${plan.entryCount} entries → ${plan.shards.length} tier-1 shards ${sizes}`
    + ` → ${plan.semifinalSizes.length} semifinals [${plan.semifinalSizes.join(", ")}] → final reveal.`;
}

// init_bracket / init_tier1_bracket take FIXED-LENGTH arrays and require every unused slot to
// be zeroed, so the layout is unambiguous on-chain.
function padNumbers(values: number[], width: number): number[] {
  const out = new Array<number>(width).fill(0);
  values.forEach((v, i) => (out[i] = v));
  return out;
}
function padKeys(values: PK[], width: number): PK[] {
  const out = new Array<PK>(width).fill(PublicKey.default);
  values.forEach((v, i) => (out[i] = v));
  return out;
}

// Player-facing flower name for a winner (matches the frontend's species map).
const SPECIES_NAMES = [
  "Sunpetal Marigold", "Tideglass Bluebell", "Duskwisp Lavender",
  "Emberfern Rose", "Mossheart Mint", "Moonsilk Lily",
];
const flowerName = (visualSpeciesId: number, flowerIndex: number) =>
  visualSpeciesId === 255
    ? `Hybrid #${flowerIndex}`
    : (SPECIES_NAMES[visualSpeciesId] ?? `Flower #${flowerIndex}`);

interface WinnerRow {
  round_number: number;
  rank: number;
  wallet_address: string;
  flower_name: string;
  generation: number;
}

interface PrizeResult {
  rank: number;
  wallet: string;
  amountSol: number;
  ok: boolean;
  error?: string;
}

/**
 * What the cycle ACTUALLY did. Every field is either a stage this run performed, or null/false
 * because it did not — the previous shape conflated "the round this cycle looked at" with "the
 * stage this cycle ran", so a cycle that only opened the next round still printed
 * "Round closed: 50 (91 entries)" and "Entries scored: 0" for a round it never touched.
 */
interface CycleSummary {
  /** The round this cycle worked on, whatever it did to it. Never implies an action. */
  processedRound: number | null;
  /** That round's on-chain participant_count, for context. */
  entryCount: number | null;
  /** Set ONLY when this run actually sent close_round. */
  closedRound: number | null;
  /** The round's REAL on-chain scored_count, read on every path (not a per-run tally). */
  scoredCount: number;
  /** How many entries THIS run scored itself. */
  scoredThisRun: number;
  /** ALWAYS player wallets, resolved through the entry→player map on every path. */
  top3: string[];
  prizes: PrizeResult[];
  /** True when the reveal ran in a PRIOR run, so this run deliberately did not distribute. */
  revealedPreviously: boolean;
  /** True when the round was already FINALIZED when the cycle started — i.e. finalized
   *  OUTSIDE auto-cycle, so no prize distribution was ever run by a cycle. */
  externallyFinalized: boolean;
  /** Set ONLY when this run actually sent finalize_round. */
  finalizedRound: number | null;
  openedRound: number | null;
}

async function main(): Promise<void> {
  // --- secrets + RPC wiring -------------------------------------------------
  // Load BOTH keys up-front (fail fast). Treasury must be ready BEFORE the cycle starts —
  // the cycle is effectively atomic, so we never want to close/score/reveal a round and only
  // THEN discover the treasury key is missing/invalid. Separate vars, separate temp files.
  const signer = loadKeypairFromEnv("OPERATOR_PRIVATE_KEY", OPERATOR_KEYPAIR_PATH);
  const treasury = loadKeypairFromEnv("TREASURY_PRIVATE_KEY", TREASURY_KEYPAIR_PATH);
  // Prove the supplied key is THIS environment's treasury before anything can be spent. Runs
  // before any RPC, any round state change and any transfer, so a wrong key costs nothing.
  if (treasury.publicKey.toBase58() !== TREASURY_PUBKEY) {
    fatal(
      `TREASURY_PRIVATE_KEY is the WRONG WALLET for this environment.\n` +
        `  supplied: ${treasury.publicKey.toBase58()}\n` +
        `  expected: ${TREASURY_PUBKEY}  (production)\n` +
        `Refusing to run. This is the PRODUCTION repo — check you have not exported the dev ` +
        `treasury key into this shell.`,
    );
  }

  const heliusUrl = process.env.HELIUS_RPC_URL;
  if (!heliusUrl || heliusUrl.trim() === "") {
    fatal("HELIUS_RPC_URL is not set. It is required for transaction send/confirm.");
  }
  if (!process.env.ARCIUM_CLUSTER_OFFSET) process.env.ARCIUM_CLUSTER_OFFSET = "456";

  // Helius for transactions + single-account reads; public devnet RPC for getProgramAccounts
  // (Helius free tier blocks it) — the exact split proven in scripts/operator.ts.
  const conn = new Connection(heliusUrl!, "confirmed");
  const publicConn = new Connection("https://api.devnet.solana.com", "confirmed");

  const wallet = new anchor.Wallet(signer);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(new URL("../target/idl/secret_garden.json", import.meta.url)).toString(),
  );
  const program = new anchor.Program<SecretGarden>(idl as SecretGarden, provider);

  const arciumEnv = arcium.getArciumEnv();
  const clusterAccount = arcium.getClusterAccAddress(arciumEnv.arciumClusterOffset);
  const mxeAccount = arcium.getMXEAccAddress(program.programId);

  const configPda = PublicKey.findProgramAddressSync(
    [Buffer.from("config")], program.programId)[0];
  const roundPda = (id: number) => PublicKey.findProgramAddressSync(
    [Buffer.from("round"), u64le(id)], program.programId)[0];
  const entryPda = (round: PK, player: PK) => PublicKey.findProgramAddressSync(
    [Buffer.from("entry"), round.toBuffer(), player.toBuffer()], program.programId)[0];

  // --- bracket-reveal PDAs (seeds per constants.rs) ---
  /** Per-round BracketState. Also the SEMIFINAL tier of a two-tier round — promote_tier1
   *  writes the semifinal partition into this same account. */
  const bracketPda = (round: PK) => PublicKey.findProgramAddressSync(
    [Buffer.from("bracket"), round.toBuffer()], program.programId)[0];
  /** Per-round Tier1State. Its very ABSENCE is what selects the single-tier code path. */
  const tier1Pda = (round: PK) => PublicKey.findProgramAddressSync(
    [Buffer.from("tier1"), round.toBuffer()], program.programId)[0];
  /** A shard reveal's result record. Index 255 is the FINAL reveal's, sharing this namespace. */
  const shardResultPda = (round: PK, shardIndex: number) => PublicKey.findProgramAddressSync(
    [Buffer.from("shardres"), round.toBuffer(), Buffer.from([shardIndex])], program.programId)[0];
  /** A semifinal reveal's result record. A SEPARATE namespace from shardres, or tier-1 shard k
   *  and semifinal k would collide on one address. */
  const semiResultPda = (round: PK, semiIndex: number) => PublicKey.findProgramAddressSync(
    [Buffer.from("semires"), round.toBuffer(), Buffer.from([semiIndex])], program.programId)[0];

  const freshOffset = () => new BN(randomBytes(8), "hex");
  const compDefAccOf = (circuit: string) => arcium.getCompDefAccAddress(
    program.programId, Buffer.from(arcium.getCompDefAccOffset(circuit)).readUInt32LE());
  const queueAccsFor = (circuit: string, offset: BN) => ({
    computationAccount: arcium.getComputationAccAddress(arciumEnv.arciumClusterOffset, offset),
    clusterAccount,
    mxeAccount,
    mempoolAccount: arcium.getMempoolAccAddress(arciumEnv.arciumClusterOffset),
    executingPool: arcium.getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
    compDefAccount: compDefAccOf(circuit),
  });

  // ---- HTTP-only send + confirm (no WebSocket on this Helius endpoint) ----
  // `payer` is the fee-payer + sole signer for the tx; defaults to the operator `signer` for
  // program instructions, but prize transfers pass the `treasury` keypair instead.
  async function sendTxHttp(
    tx: anchor.web3.Transaction,
    label: string,
    payer: anchor.web3.Keypair = signer,
  ): Promise<string> {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const bh = await conn.getLatestBlockhash({ commitment: "confirmed" });
      tx.recentBlockhash = bh.blockhash;
      tx.lastValidBlockHeight = bh.lastValidBlockHeight;
      tx.feePayer = payer.publicKey;
      tx.signatures = [];
      tx.sign(payer);
      let sig: string;
      try {
        sig = await conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: true, maxRetries: 0, preflightCommitment: "confirmed",
        });
      } catch (e) {
        console.log(`    ${label} send err (attempt ${attempt}): ${(e as Error).message.slice(0, 90)}`);
        await sleep(Math.min(6000, 500 * 2 ** (attempt - 1)));
        continue;
      }
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const st = (await conn.getSignatureStatuses([sig])).value[0];
        if (st) {
          if (st.err) throw new Error(`${label} tx FAILED: ${JSON.stringify(st.err)} (sig ${sig})`);
          if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return sig;
        }
        const h = await conn.getBlockHeight({ commitment: "confirmed" });
        if (h > bh.lastValidBlockHeight) break;
        await sleep(800);
      }
      console.log(`    ${label} not confirmed (attempt ${attempt}); retrying`);
    }
    throw new Error(`${label} failed to confirm after retries`);
  }

  // Enumerate every CompetitionEntry of a round via the public RPC (Helius free tier blocks
  // getProgramAccounts). The first field `round: pubkey` sits at offset 8 (after the
  // 8-byte discriminator). Decoded with the program's own coder.
  //
  // THE DISCRIMINATOR FILTER IS LOAD-BEARING. `round` at offset 8 is NOT unique to
  // CompetitionEntry: BracketState, Tier1State and RevealTop3V3Result all store the round
  // pubkey in the same position, so a round that has been through a bracket reveal matches
  // extra accounts — 103 instead of 91 for devnet round 50 — and decoding one of those as a
  // CompetitionEntry throws "Invalid account discriminator", aborting the cycle mid-flight.
  // Filtering server-side on the 8-byte discriminator returns only genuine entries; the
  // defensive skip below is a second layer in case a future account type is added with the
  // same discriminator prefix (it cannot be, but the cycle should degrade rather than die).
  const entryDiscriminator = program.coder.accounts.memcmp("competitionEntry") as {
    offset: number; bytes: string;
  };
  async function entriesForRound(round: PK): Promise<any[]> {
    const accounts = await publicConn.getProgramAccounts(program.programId, {
      filters: [
        { memcmp: { offset: entryDiscriminator.offset, bytes: entryDiscriminator.bytes } },
        { memcmp: { offset: 8, bytes: round.toBase58() } },
      ],
    });
    const out: any[] = [];
    for (const a of accounts) {
      try {
        out.push({
          pubkey: a.pubkey as PK,
          ...(program.coder.accounts.decode("competitionEntry", a.account.data) as any),
        });
      } catch {
        console.log(`  (skipping ${a.pubkey.toBase58()} — matched the round filter but is not a CompetitionEntry)`);
      }
    }
    return out;
  }

  /**
   * Resolve a round's top1/top2/top3 to PLAYER WALLETS.
   *
   * round.topN holds the winning ENTRY pubkey, never the player's — printing them raw is what
   * made the round-50 summary list three addresses that looked like unknown winners but were
   * actually the correct winners' entry PDAs. Every path that reports winners goes through
   * here, so the healthy path and the skip paths can never disagree again. Unfilled ranks
   * (fewer than three entrants) are omitted.
   */
  async function resolveWinnerWallets(round: PK, r: any): Promise<{ rank: number; wallet: PK }[]> {
    const entries = await entriesForRound(round);
    const byEntry = new Map<string, PK>(entries.map((e) => [(e.pubkey as PK).toBase58(), e.player as PK]));
    const out: { rank: number; wallet: PK }[] = [];
    [r.top1, r.top2, r.top3].forEach((entryPk: PK, idx: number) => {
      if (entryPk.equals(PublicKey.default)) return; // unfilled rank
      const player = byEntry.get(entryPk.toBase58());
      if (player) out.push({ rank: idx + 1, wallet: player });
      else console.log(`  ⚠ rank ${idx + 1}: entry ${entryPk.toBase58()} has no matching entry account`);
    });
    return out;
  }

  // ======================================================================================
  // STUCK-COMPUTATION RECOVERY (scoring)
  //
  // `queue_score_entry` carries `constraint = !entry.score_queued @ ScoreAlreadyQueued`, so an
  // MPC call that never comes back permanently blocks that entry — and with it the whole
  // round, because every reveal path requires scored_count == participant_count. The only way
  // out is `cancel_stuck_score`, which clears the flag once SCORE_TIMEOUT_SECONDS has elapsed.
  //
  // Before this, that was a MANUAL step: devnet round 53 wedged at 47/53 on 2026-08-11 when
  // Arcium stopped serving our MXE mid-cycle, and every subsequent run aborted on the same
  // entry with ScoreAlreadyQueued until an operator ran the cancel by hand. An unattended cron
  // has nobody to do that, so it is done here.
  // ======================================================================================

  /**
   * Clear a hung scoring computation so its entry can be re-queued.
   *
   * Returns true if a cancel was actually sent. No-ops when the entry is already scored (a late
   * callback landed while we waited) or was never queued. Waits out the remainder of the
   * on-chain cancel window when needed, re-reading first so a late callback still wins.
   */
  async function recoverStuckScore(entryPk: PK, label: string): Promise<boolean> {
    for (;;) {
      const e: any = await program.account.competitionEntry.fetch(entryPk);
      const action = stuckScoreAction(
        { scored: e.scored, scoreQueued: e.scoreQueued, queuedAt: Number(e.queuedAt) },
        Math.floor(Date.now() / 1000),
      );
      if (action.kind === "scored") {
        console.log(`    ${label}: callback landed late — already scored, no cancel needed`);
        return false;
      }
      if (action.kind === "not-queued") return false;
      if (action.kind === "cancel") break;
      // Re-read after sleeping, so a callback landing during the wait still wins.
      console.log(`    ${label}: in flight; waiting ${action.seconds}s for the on-chain cancel window`);
      await sleep(action.seconds * 1000);
    }
    console.log(`    ${label}: clearing the stuck computation (cancel_stuck_score)`);
    const tx = await program.methods.cancelStuckScore()
      .accountsPartial({ caller: signer.publicKey, entry: entryPk }).transaction();
    await sendTxHttp(tx, `cancelStuckScore`);
    return true;
  }

  /**
   * Score one entry, recovering from a hung computation and retrying up to SCORE_ATTEMPTS.
   *
   * The first recovery call also cleans up after a PREVIOUS run: an entry left flagged
   * in-flight by an aborted cycle is cleared here instead of throwing ScoreAlreadyQueued.
   */
  async function scoreEntryWithRecovery(entryPk: PK, flowerRecord: PK, label: string): Promise<void> {
    for (let attempt = 1; attempt <= SCORE_ATTEMPTS; attempt++) {
      // Clears a leftover flag from an earlier attempt OR an earlier run.
      await recoverStuckScore(entryPk, label);
      if ((await program.account.competitionEntry.fetch(entryPk)).scored) return;

      const offset = freshOffset();
      const tx = await program.methods.queueScoreEntry(offset)
        .accountsPartial({
          authority: signer.publicKey,
          round: roundPda(current),
          entry: entryPk,
          flowerRecord,
          ...queueAccsFor("score_entry_v2", offset),
        }).transaction();
      await sendTxHttp(tx, `queueScoreEntry ${label}`);

      // A timeout here is INFORMATION, not a fatal error — the retry path handles it. Without
      // this catch, one hung computation aborted the entire cycle.
      try {
        await arcium.awaitComputationFinalization(
          provider, offset, program.programId, "confirmed", SCORE_FINALIZE_TIMEOUT_MS);
      } catch (e) {
        console.log(`    ${label}: computation did not finalize on attempt ${attempt}/${SCORE_ATTEMPTS}`
          + ` (${(e as Error).message.slice(0, 70)})`);
      }

      // Poll regardless of how the wait ended: the callback may land between the two.
      for (let k = 0; k < 120; k++) {
        if ((await program.account.competitionEntry.fetch(entryPk)).scored) {
          console.log(`    ✓ scored`);
          return;
        }
        await sleep(1000);
      }
      if (attempt < SCORE_ATTEMPTS) {
        console.log(`    ${label}: no callback — recovering and retrying`);
      }
    }
    throw new Error(
      `entry ${label} did not score after ${SCORE_ATTEMPTS} attempts. The computation is being `
      + `accepted but never executed, which points at the Arcium cluster rather than this round — `
      + `check whether the cluster is serving this MXE before retrying.`);
  }

  // ======================================================================================
  // BRACKET REVEAL ORCHESTRATION
  // Port of the frontend's src/program/reveal.ts — the same sequence the Operator Panel and
  // scripts/live-reveal-round.mjs run. Every step is idempotent against the chain state it
  // reads first, so an interrupted cycle resumes rather than restarting.
  // ======================================================================================

  /** `tx` with an explicit compute-unit ceiling prepended. Does not mutate the input. */
  function withComputeUnitLimit(tx: anchor.web3.Transaction, units: number): anchor.web3.Transaction {
    const out = new anchor.web3.Transaction().add(
      anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units }));
    tx.instructions.forEach((ix) => out.add(ix));
    return out;
  }

  const metas = (keys: PK[]) => keys.map((pubkey) => ({ pubkey, isWritable: false, isSigner: false }));

  /** True once the computation's callback has written a usable result. */
  const resultReady = (res: any): boolean => !!res && res.ready && res.errorCode === 0;

  const fetchResults = async (pdas: PK[]): Promise<any[]> =>
    pdas.length === 0 ? [] : await program.account.revealTop3V3Result.fetchMultiple(pdas);

  /** Load a round's Tier1State. "stale" = the account exists but no longer decodes (a layout
   *  change), recoverable only by closing and re-pinning it. */
  async function loadTier1(tier1: PK): Promise<any | "stale" | null> {
    try {
      return await program.account.tier1State.fetchNullable(tier1);
    } catch {
      const info = await conn.getAccountInfo(tier1);
      return info ? ("stale" as const) : null;
    }
  }

  /** Does the partition already pinned on-chain match the one we just computed? */
  function partitionMatches(onChain: any, plan: BracketPlan): boolean {
    if (!onChain) return false;
    if (onChain.shardCount !== plan.shards.length) return false;
    return plan.shards.every((s, i) =>
      s.entries.length === onChain.shardSizes[i] && s.bound.equals(onChain.shardBounds[i]));
  }

  /** Poll a set of result PDAs until every one is ready, reporting each landing. */
  async function awaitResults(pdas: PK[], timeoutMs: number, label: string): Promise<number> {
    if (pdas.length === 0) return 0;
    const deadline = Date.now() + timeoutMs;
    let ready = 0;
    while (Date.now() < deadline) {
      const results = await fetchResults(pdas);
      const n = results.filter(resultReady).length;
      if (n !== ready) {
        ready = n;
        console.log(`    ${label}: ${ready}/${pdas.length} results back`);
      }
      if (ready === pdas.length) return ready;
      await sleep(RESULT_POLL_MS);
    }
    return ready;
  }

  /**
   * The three tiers of the bracket — single-tier shards, tier-1 shards and semifinals — are the
   * same shape: reveal every shard, then collect every shard's winners. Only the instructions
   * and the "already collected" bit differ, so they share one driver.
   *
   * `forceRequeue` is set when the partition was just re-pinned: any result computed under the
   * OLD partition ranked a different set of entries, so it must not be trusted even though its
   * `ready` flag is set.
   */
  async function runTier(
    spec: {
      count: number;
      noun: string;
      resultPda: (k: number) => PK;
      queue: (k: number) => Promise<void>;
      collected: (k: number) => Promise<boolean>;
      collect: (k: number) => Promise<void>;
    },
    forceRequeue: boolean,
  ): Promise<void> {
    const indices = Array.from({ length: spec.count }, (_, k) => k);
    const pdas = indices.map(spec.resultPda);
    const existing = await fetchResults(pdas);

    // Split the shards three ways: already revealed (nothing to do), queued-but-not-ready
    // (possibly still in flight), and never queued.
    let needQueue = indices.filter((k) => forceRequeue || !resultReady(existing[k]));
    if (!forceRequeue) {
      const inFlight = needQueue.filter((k) => existing[k] !== null);
      if (inFlight.length > 0) {
        console.log(`    ${inFlight.length} ${spec.noun}(s) already in flight — waiting up to ${RESUME_GRACE_MS / 1000}s`);
        await awaitResults(inFlight.map(spec.resultPda), RESUME_GRACE_MS, `${spec.noun} (resume)`);
        const settled = await fetchResults(pdas);
        needQueue = indices.filter((k) => !resultReady(settled[k]));
      }
    }

    // Queued back-to-back with no pacing — a devnet mempool-rate probe showed 20 reveal-weight
    // computations fired as fast as the RPC accepted them all landed (no 6103, no 6602), so the
    // MPC calls run concurrently instead of waiting ~40s per shard in series.
    for (let i = 0; i < needQueue.length; i++) {
      const k = needQueue[i];
      console.log(`    queueing ${spec.noun} ${i + 1}/${needQueue.length} (index ${k})`);
      await spec.queue(k);
    }

    if (needQueue.length > 0) {
      const landed = await awaitResults(needQueue.map(spec.resultPda), RESULT_TIMEOUT_MS, spec.noun);
      if (landed < needQueue.length) {
        throw new Error(
          `only ${landed} of ${needQueue.length} ${spec.noun} results came back in time — `
          + `nothing is lost, the next run resumes from here`);
      }
    }

    for (let i = 0; i < spec.count; i++) {
      if (await spec.collected(i)) continue;
      console.log(`    collecting ${spec.noun} ${i + 1}/${spec.count}`);
      await spec.collect(i);
    }
  }

  /** Single tier: pin the partition, reveal + collect every shard. */
  async function runSingleTier(round: PK, plan: BracketPlan): Promise<void> {
    const bracket = bracketPda(round);
    const existing = await program.account.bracketState.fetchNullable(bracket);
    const matches = partitionMatches(existing, plan);
    const repin = !!existing && !matches;

    if (!matches) {
      // init_bracket is `init_if_needed` and rewrites every field, so a bracket pinned from a
      // bad ordering is cleanly reset without closing anything.
      console.log(`    ${repin ? "re-pinning" : "pinning"} the shard partition (${plan.shards.length} shard(s))`);
      const tx = await program.methods
        .initBracket(padNumbers(plan.sizes, MAX_SHARDS),
          padKeys(plan.shards.map((s) => s.bound), MAX_SHARDS), plan.shards.length)
        .accountsPartial({ authority: signer.publicKey, config: configPda, round, bracket })
        .transaction();
      await sendTxHttp(tx, "initBracket");
    }

    await runTier({
      count: plan.shards.length,
      noun: "shard",
      resultPda: (k) => shardResultPda(round, k),
      queue: async (k) => {
        const offset = freshOffset();
        const tx = await program.methods.queueShardReveal(offset, k)
          .accountsPartial({
            authority: signer.publicKey, config: configPda, round, bracket,
            result: shardResultPda(round, k),
            ...queueAccsFor("reveal_top3_v5", offset),
          })
          .remainingAccounts(metas(plan.shards[k].entries))
          .transaction();
        await sendTxHttp(withComputeUnitLimit(tx, REVEAL_CU_LIMIT), `queueShardReveal[${k}]`);
      },
      collected: async (k) => {
        const b: any = await program.account.bracketState.fetch(bracket);
        return (b.shardsCollected & (1 << k)) !== 0;
      },
      collect: async (k) => {
        const tx = await program.methods.collectShardWinners(k)
          .accountsPartial({
            authority: signer.publicKey, config: configPda, round, bracket,
            result: shardResultPda(round, k),
          })
          .remainingAccounts(metas(plan.shards[k].entries))
          .transaction();
        await sendTxHttp(tx, `collectShardWinners[${k}]`);
      },
    }, repin);
  }

  /** Two tiers: pin tier-1, reveal + collect its shards, promote, then run the semifinals as
   *  an ordinary BracketState (promote_tier1 wrote that partition on-chain — it is READ here,
   *  never guessed). */
  async function runTwoTier(round: PK, plan: BracketPlan): Promise<void> {
    const bracket = bracketPda(round);
    const tier1 = tier1Pda(round);

    const existing = await loadTier1(tier1);
    const stale = existing === "stale";
    const decoded = stale ? null : existing;
    const matches = partitionMatches(decoded, plan);
    // A promoted tier 1 is finished and its winners are already in BracketState — never disturb
    // it, even if the pinned partition looks unfamiliar.
    const promoted = !!decoded && decoded.promoted !== 0;
    const repin = !promoted && (stale || (!!decoded && !matches));

    if (repin && (stale || decoded)) {
      // init_tier1_bracket is `init`, NOT `init_if_needed` — pinning is one-shot, so re-pinning
      // has to be an explicit close first.
      console.log(`    clearing the stale tier-1 partition`);
      const tx = await program.methods.closeTier1Bracket()
        .accountsPartial({ authority: signer.publicKey, config: configPda, round, tier1 })
        .transaction();
      await sendTxHttp(tx, "closeTier1Bracket");
    }

    if (!decoded || repin) {
      console.log(`    pinning the tier-1 partition (${plan.shards.length} shards)`);
      const tx = await program.methods
        .initTier1Bracket(padNumbers(plan.sizes, MAX_TIER1_SHARDS),
          padKeys(plan.shards.map((s) => s.bound), MAX_TIER1_SHARDS), plan.shards.length)
        .accountsPartial({ authority: signer.publicKey, config: configPda, round, tier1 })
        .transaction();
      await sendTxHttp(tx, "initTier1Bracket");
    }

    if (!promoted) {
      await runTier({
        count: plan.shards.length,
        noun: "tier-1 shard",
        resultPda: (k) => shardResultPda(round, k),
        queue: async (k) => {
          const offset = freshOffset();
          const tx = await program.methods.queueTier1ShardReveal(offset, k)
            .accountsPartial({
              authority: signer.publicKey, config: configPda, round, tier1,
              result: shardResultPda(round, k),
              ...queueAccsFor("reveal_top3_v5", offset),
            })
            .remainingAccounts(metas(plan.shards[k].entries))
            .transaction();
          await sendTxHttp(withComputeUnitLimit(tx, REVEAL_CU_LIMIT), `queueTier1ShardReveal[${k}]`);
        },
        collected: async (k) => {
          const t: any = await program.account.tier1State.fetch(tier1);
          return t.shardDone[k] !== 0;
        },
        collect: async (k) => {
          const tx = await program.methods.collectTier1Winners(k)
            .accountsPartial({
              authority: signer.publicKey, config: configPda, round, tier1,
              result: shardResultPda(round, k),
            })
            .remainingAccounts(metas(plan.shards[k].entries))
            .transaction();
          await sendTxHttp(tx, `collectTier1Winners[${k}]`);
        },
      }, repin);

      console.log(`    promoting tier-1 winners to the semifinals`);
      const tx = await program.methods.promoteTier1()
        .accountsPartial({ authority: signer.publicKey, config: configPda, round, tier1, bracket })
        .transaction();
      await sendTxHttp(tx, "promoteTier1");
    }

    const t1: any = await program.account.tier1State.fetch(tier1);
    const b: any = await program.account.bracketState.fetch(bracket);
    const semis = b.shardCount;
    const winners: PK[] = t1.winners.slice(0, t1.winnerCount);
    const sliceFor = (k: number) => {
      const start = b.shardSizes.slice(0, k).reduce((a: number, s: number) => a + s, 0);
      return winners.slice(start, start + b.shardSizes[k]);
    };

    await runTier({
      count: semis,
      noun: "semifinal",
      resultPda: (k) => semiResultPda(round, k),
      queue: async (k) => {
        const offset = freshOffset();
        const tx = await program.methods.queueSemifinalReveal(offset, k)
          .accountsPartial({
            authority: signer.publicKey, config: configPda, round, tier1, bracket,
            result: semiResultPda(round, k),
            ...queueAccsFor("reveal_top3_v5", offset),
          })
          .remainingAccounts(metas(sliceFor(k)))
          .transaction();
        await sendTxHttp(withComputeUnitLimit(tx, REVEAL_CU_LIMIT), `queueSemifinalReveal[${k}]`);
      },
      collected: async (k) => {
        const cur: any = await program.account.bracketState.fetch(bracket);
        return (cur.shardsCollected & (1 << k)) !== 0;
      },
      // No entry accounts: the slice is Tier1State.winners[start..], already on-chain.
      collect: async (k) => {
        const tx = await program.methods.collectSemifinalWinners(k)
          .accountsPartial({
            authority: signer.publicKey, config: configPda, round, tier1, bracket,
            result: semiResultPda(round, k),
          })
          .transaction();
        await sendTxHttp(tx, `collectSemifinalWinners[${k}]`);
      },
    }, false);
  }

  /**
   * Run the whole bracket reveal for `round`, from wherever it stands to scoring_revealed.
   * Returns the plan actually used, for the cycle log.
   */
  async function runBracketReveal(round: PK, entryKeys: PK[]): Promise<BracketPlan> {
    const plan = planBracket(entryKeys);
    console.log(`  plan: ${describePlan(plan)}`);

    if (plan.tier === "two") await runTwoTier(round, plan);
    else await runSingleTier(round, plan);

    // ---- FINAL reveal + apply. Identical for both tiers: by this point BracketState holds the
    // finalists either way, so the two-tier path rejoins the single-tier code here.
    const bracket = bracketPda(round);
    const single = plan.shards.length === 1 && plan.tier === "single";
    const finalIndex = single ? 0 : FINAL_SHARD_INDEX;
    const finalResult = shardResultPda(round, finalIndex);

    if (!single) {
      const b: any = await program.account.bracketState.fetch(bracket);
      if (!b.finalQueued) {
        // The program checks the supplied finalists against BracketState.finalists and requires
        // them ascending, so they are re-sorted here — collection order is rank order, not
        // pubkey order.
        const finalists = sortEntriesByteWise(b.finalists.slice(0, b.finalistCount));
        console.log(`    final reveal over ${finalists.length} finalists`);
        const offset = freshOffset();
        const tx = await program.methods.queueShardReveal(offset, FINAL_SHARD_INDEX)
          .accountsPartial({
            authority: signer.publicKey, config: configPda, round, bracket,
            result: finalResult,
            ...queueAccsFor("reveal_top3_v5", offset),
          })
          .remainingAccounts(metas(finalists))
          .transaction();
        await sendTxHttp(withComputeUnitLimit(tx, REVEAL_CU_LIMIT), "queueShardReveal[FINAL]");
      }
      const landed = await awaitResults([finalResult], RESULT_TIMEOUT_MS, "final reveal");
      if (landed === 0) {
        // NOT auto-recoverable, unlike a shard reveal. Shard/tier-1/semifinal result PDAs are
        // `init_if_needed` with no "already queued" constraint, so runTier just re-queues them.
        // The FINAL reveal is gated by BracketState.final_queued, which only init_bracket and
        // promote_tier1 reset — and both bump `generation`, invalidating EVERY shard result and
        // forcing the whole tier to be recomputed. That is too destructive to do automatically
        // (up to 17 shards of MPC work), and on a two-tier round re-running init_bracket would
        // also clobber the semifinal partition promote_tier1 wrote. So this stops and says so
        // rather than looping: a later run would skip the queue (final_queued is still set) and
        // wait again forever.
        throw new Error(
          `the final reveal was queued but never came back. This does NOT self-heal: `
          + `BracketState.final_queued is set, so re-running will wait rather than re-queue. `
          + `Check the Arcium cluster is serving this MXE first; recovery then needs `
          + `final_queued cleared by re-pinning the bracket, which discards every shard result `
          + `for round ${current} and re-runs that tier.`);
      }
    }

    console.log(`    applying the bracket result (writing winners on-chain)`);
    const tx = await program.methods.applyBracketResult(finalIndex)
      .accountsPartial({ authority: signer.publicKey, config: configPda, round, bracket, result: finalResult })
      .transaction();
    await sendTxHttp(tx, "applyBracketResult");
    return plan;
  }

  // Player-facing name for a winner whose FlowerRecord no longer exists — see operator.ts.
  const CLOSED_FLOWER_NAME = "Retired Bloom";

  // Persist a finished round's results to Supabase (same pattern as operator.ts). Skipped
  // silently when SUPABASE_URL/SERVICE_KEY aren't set; never fatal to the cycle.
  //
  // NOTHING IN HERE MAY THROW. This runs unattended on Railway between the reveal and prize
  // distribution (see the call site), and main() has no try/catch around that sequence — the
  // only handler is the top-level .catch(process.exit(1)). A throw here would exit with the
  // winners revealed but the prizes unpaid, the round never finalized and the next round never
  // opened: it would cost that day's round outright.
  //
  // Writes are ON CONFLICT DO NOTHING (upsert + ignoreDuplicates). True duplication is already
  // impossible since the 2026-08-13 migration gave round_results a round_number key and
  // round_winners the composite (round_number, rank) key, both declared in the frontend's
  // supabase/round_results.sql; this just turns a re-run — or a round the set-round-results
  // edge function already published from the Operator Panel — into a quiet no-op instead of a
  // logged 23505.
  async function saveResultsToSupabase(roundNumber: number, round: any, scored: any[]) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) return;

    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(url, key);
    const targetTraits: number[] = (round.targetTraits as number[]).slice(0, round.targetTraitCount);

    // `.select()` reports what was actually written: empty means the conflict was ignored.
    const results = await supabase
      .from("round_results")
      .upsert(
        {
          round_number: roundNumber,
          target_traits: JSON.stringify(targetTraits),
          total_entrants: round.participantCount,
          completed_at: new Date().toISOString(),
        },
        { onConflict: "round_number", ignoreDuplicates: true },
      )
      .select("round_number");

    const byEntry = new Map<string, any>(scored.map((e) => [(e.pubkey as PK).toBase58(), e]));
    const top: PK[] = [round.top1, round.top2, round.top3];
    const winnerRows: WinnerRow[] = [];
    for (let i = 0; i < top.length; i++) {
      const entry = byEntry.get(top[i].toBase58());
      if (!entry) continue;
      // fetchNullable, NOT fetch: fetch() THROWS on a closed account, and a winner may have
      // closed their flower after the round to reclaim its rent — the exact unattended crash
      // this function must not have. Devnet round 24 already has such a winner.
      const flower: any = await program.account.flowerRecord.fetchNullable(entry.flowerRecord);
      winnerRows.push({
        round_number: roundNumber,
        rank: i + 1,
        wallet_address: (entry.player as PK).toBase58(),
        flower_name: flower
          ? flowerName(flower.visualSpeciesId, flower.flowerIndex)
          : CLOSED_FLOWER_NAME,
        generation: flower ? flower.generation : 0,
      });
    }
    const winners = winnerRows.length
      ? await supabase
          .from("round_winners")
          .upsert(winnerRows, { onConflict: "round_number,rank", ignoreDuplicates: true })
          .select("rank")
      : null;

    if (results.error || winners?.error) {
      console.log(`  (Supabase write error: ${(results.error ?? winners!.error)!.message})`);
      return;
    }
    const wrote = (results.data?.length ?? 0) > 0 || (winners?.data?.length ?? 0) > 0;
    console.log(wrote ? `  Results saved to Supabase` : `  Results were already published to Supabase`);
  }

  // Pay the SOL prize pool from the Treasury to each winner wallet, sequentially (rank 1, then
  // 2, then 3). Each transfer is independent: a failure is logged and recorded but does NOT
  // abort the others or the surrounding cycle — a failed payout is surfaced for MANUAL retry.
  async function distributePrizes(
    winners: { rank: number; wallet: PK }[],
  ): Promise<PrizeResult[]> {
    const results: PrizeResult[] = [];
    for (const w of winners) {
      const sol = PRIZE_SOL[w.rank - 1];
      const lamports = Math.round(sol * LAMPORTS_PER_SOL);
      try {
        const tx = new anchor.web3.Transaction().add(
          anchor.web3.SystemProgram.transfer({
            fromPubkey: treasury.publicKey,
            toPubkey: w.wallet,
            lamports,
          }),
        );
        // Treasury is the fee-payer + source, so it (not the operator) signs this tx.
        const sig = await sendTxHttp(tx, `prize rank ${w.rank} (${sol} SOL)`, treasury);
        console.log(`  ✓ rank ${w.rank}: sent ${sol} SOL to ${w.wallet.toBase58()} (sig ${short(sig)})`);
        results.push({ rank: w.rank, wallet: w.wallet.toBase58(), amountSol: sol, ok: true });
      } catch (e) {
        const msg = (e as Error).message;
        console.error(`  ✗ rank ${w.rank}: FAILED to send ${sol} SOL to ${w.wallet.toBase58()} — ${msg}`);
        console.error(`    (cycle continues; retry this payout manually)`);
        results.push({ rank: w.rank, wallet: w.wallet.toBase58(), amountSol: sol, ok: false, error: msg });
      }
    }
    return results;
  }

  // --- balance gates (operator fees + treasury prize pool) ------------------
  // Both checked BEFORE any cycle work so a low balance skips the day cleanly rather than
  // closing a round and then stalling.
  console.log(`\n=== Secret Garden — AUTO-CYCLE (cluster ${arciumEnv.arciumClusterOffset}) ===`);
  console.log(`  revision        : ${runningRevision()}`);
  console.log(`  program         : ${program.programId.toBase58()}`);
  console.log(`  operator wallet : ${signer.publicKey.toBase58()}`);
  console.log(`  treasury wallet : ${treasury.publicKey.toBase58()}`);

  const startLamports = await rpcRead("operator balance",
    () => conn.getBalance(signer.publicKey, "confirmed"));
  const startSol = startLamports / LAMPORTS_PER_SOL;
  if (startSol < MIN_BALANCE_SOL) {
    console.error(
      `\nACTION REQUIRED — LOW BALANCE: operator wallet ${signer.publicKey.toBase58()} ` +
      `holds ${startSol.toFixed(4)} SOL, below the ${MIN_BALANCE_SOL} SOL minimum.`);
    console.error(`Top up this wallet, then the next scheduled run will proceed. Skipping the cycle.`);
    process.exit(1);
  }
  console.log(`  operator balance: ${startSol.toFixed(4)} SOL (>= ${MIN_BALANCE_SOL} minimum) — proceeding`);

  const treasuryStartSol = (await rpcRead("treasury balance",
    () => conn.getBalance(treasury.publicKey, "confirmed"))) / LAMPORTS_PER_SOL;
  if (treasuryStartSol < MIN_TREASURY_SOL) {
    console.error(
      `\nACTION REQUIRED — LOW TREASURY BALANCE: treasury wallet ${treasury.publicKey.toBase58()} ` +
      `holds ${treasuryStartSol.toFixed(4)} SOL, below the ${MIN_TREASURY_SOL} SOL minimum ` +
      `(one day's prize pool is ${PRIZE_SOL.reduce((a, b) => a + b, 0)} SOL).`);
    console.error(`Top up the treasury, then the next scheduled run will proceed. Skipping the cycle.`);
    process.exit(1);
  }
  console.log(`  treasury balance: ${treasuryStartSol.toFixed(4)} SOL (>= ${MIN_TREASURY_SOL} minimum) — proceeding`);

  // --- authorization: wallet must be the config authority or a registered operator ------
  // Same retry as the balance gates: this is the third of the three opening reads, and an
  // unretried blip here would abort the cycle for the identical reason.
  const cfg: any = await rpcRead("GameConfig", () => program.account.gameConfig.fetch(configPda));
  const isAuthority = cfg.authority.equals(signer.publicKey);
  const operators: PK[] = (cfg.operators as PK[]).slice(0, cfg.operatorCount);
  const isOperator = operators.some((op) => op.equals(signer.publicKey));
  if (!isAuthority && !isOperator) {
    fatal(
      `wallet ${short(signer.publicKey)} is neither the config authority (${short(cfg.authority)}) ` +
      `nor a registered operator — it cannot run the cycle.`);
  }
  console.log(`  authorized as   : ${isAuthority ? "AUTHORITY" : "OPERATOR"}`);

  // --- comp-def pre-flight --------------------------------------------------------------
  // Every circuit this cycle will queue, verified against the DEPLOYED PROGRAM before any
  // state changes.
  //
  // WHY EXISTENCE IS NOT ENOUGH. The obvious check — derive the comp-def PDA and confirm it
  // exists and is finalized — does not work here, and believing it does is how round 57
  // stranded six players. On shared cluster 456 a superseded comp def can NEVER be closed (the
  // on-chain close needs an empty execpool, and another MXE's expired computations have squatted
  // it since 2026-08-02), so `reveal_top3_v3` and `breed` are both still registered and still
  // finalized right now. A stale name therefore passes an existence check and then fails
  // ConstraintAddress (2012) at queue time anyway.
  //
  // WHAT ACTUALLY DISCRIMINATES. `comp_def_offset(..)` is a const evaluated at compile time, so
  // each offset is embedded in the program binary as 4 little-endian bytes. Scanning the
  // deployed programdata for them answers the only question that matters: does the program
  // THIS SCRIPT IS TALKING TO actually know the circuit names this script is about to send?
  // That is the exact gap a push gap opens — Railway running an older revision than the chain —
  // and it is invisible to every account-level check.
  //
  // The timing is the point. The reveal is the LAST stage, so without this the cycle closes the
  // round and scores every entry before failing, leaving the round closed-and-scored and
  // unrevealable until someone intervenes by hand.
  {
    const needed = ["score_entry_v2", "reveal_top3_v5"] as const;
    console.log(`  comp-defs       : verifying ${needed.length} circuit(s) against the deployed program…`);

    const [programDataPda] = PublicKey.findProgramAddressSync(
      [program.programId.toBuffer()],
      new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"));
    const programData = await rpcRead("deployed programdata",
      () => conn.getAccountInfo(programDataPda, "confirmed"));
    if (!programData) {
      fatal(`could not read programdata at ${programDataPda.toBase58()} — cannot verify circuit names.`);
    }

    for (const circuit of needed) {
      const offsetLe = Buffer.from(arcium.getCompDefAccOffset(circuit)).subarray(0, 4);
      const pda = compDefAccOf(circuit);
      const embedded = programData!.data.indexOf(offsetLe) >= 0;

      if (!embedded) {
        fatal(
          `circuit "${circuit}" is NOT known to the deployed program.\n` +
          `  Its comp-def offset (0x${offsetLe.toString("hex")}) does not appear in the deployed\n` +
          `  binary, so the program never references this name and every queue using it would\n` +
          `  fail ConstraintAddress (2012) on comp_def_account.\n` +
          `  This is the signature of a REVISION MISMATCH: the circuit was renamed and this\n` +
          `  script is older (or newer) than the program actually deployed on chain. Note the\n` +
          `  comp-def account itself may well still exist and be finalized — superseded comp\n` +
          `  defs cannot be closed on cluster 456 — so its presence proves nothing.\n` +
          `  Running revision: ${runningRevision()}\n` +
          `  Aborting BEFORE any round state changes.`);
      }

      // Secondary, and genuinely additive: the name is right, but was the circuit ever
      // uploaded and finalized? Catches a fresh circuit registered but not yet complete.
      // Deliberately asymmetric — a missing account is fatal, an unreadable finalization flag
      // only warns, because the SDK's account shape has moved between versions and refusing to
      // run production over a renamed field would be a worse failure than the one prevented.
      const info = await rpcRead(`comp-def ${circuit}`, () => conn.getAccountInfo(pda, "confirmed"));
      if (!info) {
        fatal(
          `circuit "${circuit}" is known to the program but its comp def does not exist at\n` +
          `  ${pda.toBase58()} — it was never registered. Run the uploader for this circuit.\n` +
          `  Aborting BEFORE any round state changes.`);
      }
      let finalized: boolean | null = null;
      try {
        const arciumProgram = arcium.getArciumProgram(provider);
        const cd: any = await arciumProgram.account.computationDefinitionAccount.fetch(pda);
        const flag = cd?.circuitSource?.onChain?.[0]?.isCompleted;
        if (typeof flag === "boolean") finalized = flag;
      } catch {
        finalized = null;
      }
      if (finalized === false) {
        fatal(
          `circuit "${circuit}" exists at ${pda.toBase58()} but is NOT finalized — its upload\n` +
          `  never completed, so the cluster cannot execute it. Re-run the uploader.\n` +
          `  Aborting BEFORE any round state changes.`);
      }

      console.log(
        `    ${circuit.padEnd(16)} in-binary OK  ${pda.toBase58()}  ` +
        `${finalized === true ? "finalized" : "exists (finalization flag unreadable)"}`);
    }
  }

  const current = cfg.currentRound.toNumber();
  const summary: CycleSummary = {
    processedRound: null, entryCount: null, closedRound: null,
    scoredCount: 0, scoredThisRun: 0, top3: [], prizes: [],
    revealedPreviously: false, externallyFinalized: false,
    finalizedRound: null, openedRound: null,
  };

  // First-ever run (no round opened yet): there is nothing to close/score/reveal/finalize —
  // just open round 1.
  if (current === 0) {
    console.log(`\n[open] no round has ever been opened — opening round 1`);
    await openNextRound(0);
    summary.openedRound = 1;
    printSummary(summary, await balanceSol(), await treasuryBalanceSol());
    return;
  }

  const round = roundPda(current);

  // ---------------------------------------------------------------- 1. CLOSE
  let r: any = await program.account.competitionRound.fetch(round);
  summary.processedRound = current;
  summary.entryCount = r.participantCount;
  console.log(`\n[close] round ${current} is ${ROUND_STATUS_NAME[r.status]}, ${r.participantCount} entries`);

  // A round already FINALIZED when the cycle STARTS was finalized by something other than a
  // cycle — a manual bracket reveal, the operator panel, or a partial run someone finished by
  // hand. That path has no prize step, and the reveal branch below will (correctly) skip
  // distribution, so without this warning the run reports "no payouts this run" for a round
  // whose winners may never have been paid at all. Devnet round 50 is exactly that case: 91
  // entrants, finalized manually on 2026-08-09, 1.5 SOL of prizes never sent.
  if (r.status === ROUND_STATUS_FINALIZED) {
    summary.externallyFinalized = true;
    console.log(`\n  ${"!".repeat(72)}`);
    console.log(`  ⚠ ACTION REQUIRED — ROUND ${current} WAS FINALIZED EXTERNALLY`);
    console.log(`    This round was already FINALIZED before the cycle started, so it was`);
    console.log(`    finalized OUTSIDE auto-cycle (manual reveal / operator panel).`);
    console.log(`    PRIZE DISTRIBUTION WAS NOT RUN BY THIS CYCLE — auto-cycle only pays after a`);
    console.log(`    reveal it performed itself. Verify manually whether prizes are owed for`);
    console.log(`    round ${current} and pay them if so. This cycle will only open the next round.`);
    console.log(`  ${"!".repeat(72)}`);
  }

  // Anchor hands back i64 as a BN; tolerate a plain number too.
  const roundEndTime =
    typeof r.endTime?.toNumber === "function" ? r.endTime.toNumber() : Number(r.endTime);
  const closeAction = closeRoundAction(
    { status: r.status, endTime: roundEndTime },
    Math.floor(Date.now() / 1000),
  );

  if (closeAction.kind === "close") {
    const tx = await program.methods.closeRound()
      .accountsPartial({ authority: signer.publicKey, config: configPda, round }).transaction();
    await sendTxHttp(tx, `closeRound(${current})`);
    r = await program.account.competitionRound.fetch(round);
    // Set ONLY here: this run genuinely closed the round.
    summary.closedRound = current;
    summary.entryCount = r.participantCount;
    console.log(`  ✓ round ${current} closed (${r.participantCount} entries)`);
  } else if (closeAction.kind === "too-early") {
    // The round is still LIVE. Closing it now would end the day early with whatever entries
    // happen to be in — on a freshly opened round, that is zero: no winners, no prizes, and
    // players locked out until the next round. There is nothing else this cycle can legally do
    // either (queue_score_entry requires CLOSED), so stop here rather than fall through.
    console.log(
      `  ↪ skipping close — round ${current} is still live, ` +
      `${formatRemaining(closeAction.remainingSeconds)} remaining ` +
      `(ends ${new Date(roundEndTime * 1000).toISOString()}).`,
    );
    console.log(`     Nothing to do until then. This run was off-schedule (a redeploy runs a`);
    console.log(`     full cycle immediately), and an off-schedule run must never close a live round.`);
    printSummary(summary, await balanceSol(), await treasuryBalanceSol());
    return;
  } else {
    console.log(`  ↪ skipping close — round already ${ROUND_STATUS_NAME[r.status]}`);
  }

  // The round's REAL scored_count, read on every path so a skipped scoring stage reports what
  // is actually on-chain rather than the zero-initialised per-run tally.
  summary.scoredCount = r.scoredCount;
  const hasEntries = r.participantCount > 0;

  // ---------------------------------------------------------------- 2. SCORE
  if (r.status === ROUND_STATUS_FINALIZED) {
    console.log(`\n[score] skipping — round ${current} already FINALIZED`);
  } else if (!hasEntries) {
    console.log(`\n[score] skipping — round ${current} has 0 entries`);
  } else {
    const entries = await entriesForRound(round);
    const unscored = entries.filter((e) => !e.scored);
    console.log(`\n[score] round ${current}: ${entries.length} entries, ${unscored.length} unscored`);
    for (let i = 0; i < unscored.length; i++) {
      const e = unscored[i];
      const entry = entryPda(round, e.player as PK);
      console.log(`  scoring ${i + 1}/${unscored.length} (wallet ${short(e.player as PK)})`);
      // Retries + clears a hung computation itself; only throws once genuinely out of attempts.
      await scoreEntryWithRecovery(
        entry, e.flowerRecord as PK, `${i + 1}/${unscored.length} ${short(e.player as PK)}`);
      summary.scoredThisRun += 1;
    }
    const after: any = await program.account.competitionRound.fetch(round);
    summary.scoredCount = after.scoredCount;
    console.log(`  ✓ all entries scored (scoredCount=${after.scoredCount})`);
  }

  // --------------------------------------------------------------- 3. REVEAL
  // Always via the BRACKET (see the header). Winners are resolved to PLAYER WALLETS on every
  // path through resolveWinnerWallets, so the summary can never again print raw entry PDAs.
  r = await program.account.competitionRound.fetch(round);
  if (r.status === ROUND_STATUS_FINALIZED) {
    console.log(`\n[reveal] skipping — round ${current} already FINALIZED (see the warning above)`);
    summary.top3 = (await resolveWinnerWallets(round, r)).map((w) => w.wallet.toBase58());
  } else if (r.scoringRevealed) {
    // Resumed run: reveal already happened previously, so prizes were (or should have been)
    // paid by that run. We do NOT auto-distribute again — there is no on-chain payout ledger,
    // so re-paying here would double-pay. Surface it for manual verification instead.
    summary.revealedPreviously = true;
    console.log(`\n[reveal] already revealed in a prior run — reusing stored winners`);
    console.log(`  ⚠ NOT auto-distributing prizes (double-pay guard). If the prior run's payouts`);
    console.log(`    did not complete, verify on-chain and pay the affected winner(s) manually.`);
    summary.top3 = (await resolveWinnerWallets(round, r)).map((w) => w.wallet.toBase58());
  } else if (!hasEntries) {
    console.log(`\n[reveal] skipping — round ${current} has 0 entries (nothing to rank)`);
  } else {
    if (r.scoredCount !== r.participantCount) {
      throw new Error(`scoring incomplete: ${r.scoredCount}/${r.participantCount} scored`);
    }
    const entries = await entriesForRound(round);
    const scored = entries.filter((e) => e.scored);
    if (scored.length !== r.participantCount) {
      throw new Error(`found ${scored.length} scored entries but participantCount=${r.participantCount}`);
    }

    console.log(`\n[reveal] running the bracket for round ${current} (${scored.length} entries)`);
    await runBracketReveal(round, scored.map((e) => e.pubkey as PK));

    const rr: any = await program.account.competitionRound.fetch(round);
    if (!rr.scoringRevealed) {
      throw new Error("bracket applied but round.scoringRevealed never flipped");
    }

    // Resolve each filled rank to its PLAYER WALLET (round.topN holds the winning ENTRY
    // pubkey; the prize goes to the player, not the entry account).
    const winnerWallets = await resolveWinnerWallets(round, rr);
    summary.top3 = winnerWallets.map((w) => w.wallet.toBase58());
    console.log(`  ✓ winners revealed:`);
    winnerWallets.forEach((w) => console.log(`    ${w.rank}: ${w.wallet.toBase58()}`));
    await saveResultsToSupabase(current, rr, scored);

    // --- PRIZE DISTRIBUTION (after a successful reveal, before finalize) ---
    console.log(`\n[distribute] paying prize pool from treasury to ${winnerWallets.length} winner(s)...`);
    summary.prizes = await distributePrizes(winnerWallets);
  }

  // ------------------------------------------------------------- 4. FINALIZE
  r = await program.account.competitionRound.fetch(round);
  if (r.status === ROUND_STATUS_FINALIZED) {
    console.log(`\n[finalize] skipping — round ${current} already FINALIZED`);
  } else {
    const tx = await program.methods.finalizeRound()
      .accountsPartial({ authority: signer.publicKey, config: configPda, round }).transaction();
    await sendTxHttp(tx, `finalizeRound(${current})`);
    // Set ONLY here: this run genuinely finalized the round.
    summary.finalizedRound = current;
    console.log(`\n[finalize] ✓ round ${current} finalized`);
  }

  // ----------------------------------------------------------------- 5. OPEN
  console.log(`\n[open] opening round ${current + 1}`);
  await openNextRound(current);
  summary.openedRound = current + 1;

  // Log treasury balance after distribution (per spec) and include it in the summary.
  const treasuryEndSol = await treasuryBalanceSol();
  console.log(`\n[treasury] balance after distribution: ${treasuryEndSol.toFixed(4)} SOL`);
  printSummary(summary, await balanceSol(), treasuryEndSol);

  // --- local helpers that close over the wired-up program/provider ----------
  async function openNextRound(currentRound: number): Promise<void> {
    const tx = await program.methods.openRound()
      .accountsPartial({
        authority: signer.publicKey,
        config: configPda,
        previousRound: currentRound > 0 ? roundPda(currentRound) : null,
        round: roundPda(currentRound + 1),
      }).transaction();
    await sendTxHttp(tx, `openRound(${currentRound + 1})`);
    const opened: any = await program.account.competitionRound.fetch(roundPda(currentRound + 1));
    console.log(`  ✓ round ${currentRound + 1} opened — target traits `
      + `[${Array.from(opened.targetTraits).slice(0, opened.targetTraitCount)}] `
      + `(count ${opened.targetTraitCount})`);
  }

  // Closing balances feed the summary only, but they run AFTER the cycle has done real work —
  // a blip here would report the run as FAILED even though every stage succeeded.
  async function balanceSol(): Promise<number> {
    return (await rpcRead("operator balance",
      () => conn.getBalance(signer.publicKey, "confirmed"))) / LAMPORTS_PER_SOL;
  }

  async function treasuryBalanceSol(): Promise<number> {
    return (await rpcRead("treasury balance",
      () => conn.getBalance(treasury.publicKey, "confirmed"))) / LAMPORTS_PER_SOL;
  }
}

function printSummary(s: CycleSummary, operatorSol: number, treasurySol: number): void {
  const line = "─".repeat(48);
  console.log(`\n${line}`);
  console.log(`AUTO-CYCLE COMPLETE`);
  console.log(line);
  // Every line states what THIS RUN did. A stage the run skipped says so explicitly rather
  // than borrowing the round's number and reading as though it had happened.
  console.log(`  Round processed    : ${s.processedRound ?? "—"}`
    + (s.entryCount === null ? "" : ` (${s.entryCount} entries)`));
  console.log(`  Round closed       : ${s.closedRound === null
    ? "— (not closed by this run)" : s.closedRound}`);
  console.log(`  Entries scored     : ${s.scoredThisRun} by this run`
    + ` (round total on-chain: ${s.scoredCount}${s.entryCount === null ? "" : `/${s.entryCount}`})`);
  console.log(`  Top 3 (wallets)    : ${s.top3.length ? "" : "—"}`);
  s.top3.forEach((w, i) => console.log(`    ${i + 1}. ${w}`));
  const noPayoutReason = s.externallyFinalized
    ? "— NOT RUN (round finalized externally — verify prizes manually)"
    : s.revealedPreviously
      ? "— not run (already revealed by a prior run; double-pay guard)"
      : s.top3.length === 0
        ? "— (no winners to pay)"
        : "— (no payouts this run)";
  console.log(`  Prize distribution : ${s.prizes.length ? "" : noPayoutReason}`);
  s.prizes.forEach((p) =>
    console.log(`    rank ${p.rank}: ${p.amountSol} SOL -> ${p.wallet}  [${p.ok ? "SENT" : "FAILED"}]`
      + (p.ok || !p.error ? "" : ` (${p.error})`)));
  const failed = s.prizes.filter((p) => !p.ok);
  if (failed.length) {
    console.log(`    ⚠ ${failed.length} payout(s) FAILED — retry manually: `
      + failed.map((p) => `rank ${p.rank} (${p.amountSol} SOL -> ${p.wallet})`).join(", "));
  }
  console.log(`  Round finalized    : ${s.finalizedRound === null
    ? (s.externallyFinalized ? "— (was already finalized externally)" : "— (not finalized by this run)")
    : s.finalizedRound}`);
  console.log(`  New round opened   : ${s.openedRound ?? "—"}`);
  console.log(`  Operator balance   : ${operatorSol.toFixed(4)} SOL`);
  console.log(`  Treasury balance   : ${treasurySol.toFixed(4)} SOL`);
  if (s.externallyFinalized) {
    console.log(line);
    console.log(`  ⚠ Round ${s.processedRound} was finalized OUTSIDE auto-cycle. No prizes were`);
    console.log(`    distributed by this cycle. Verify manually whether prizes are owed.`);
  }
  console.log(line);
}

/**
 * Run the cycle only when this file is the process ENTRY POINT.
 *
 * Importing it (tests/auto-cycle-bracket.ts exercises the pure partition planner against every
 * round size the program accepts) must not launch a live cycle against devnet. Railway invokes
 * it directly — `node --experimental-strip-types scripts/auto-cycle.ts` — which still matches.
 */
const isEntryPoint =
  !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  // Single-instance gate, BEFORE any chain reads or key material is written: a run that is not
  // going to proceed should touch nothing at all. Exit 0, not 1 — standing down because another
  // run holds the lock is correct behaviour, not a failure, and Railway should not flag it.
  if (!acquireLock()) {
    process.exit(0);
  } else {
    main()
      .then(() => process.exit(0)) // temp keys + lock removed by the process 'exit' handler
      .catch((e) => {
        console.error(`\nAUTO-CYCLE FAILED: ${(e as Error).message}`);
        process.exit(1);
      });
  }
}

// Exported for tests ONLY — the pure, chain-free partition planner. Nothing here touches the
// network, a keypair or the program.
export {
  compareEntryKeys, sortEntriesByteWise, planShardSizes, expectedTier1Winners,
  planBracket, describePlan, padNumbers, padKeys, BracketPlanError,
  MAX_SHARD_SIZE, MAX_SHARDS, MAX_TIER1_SHARDS, SHARD_WINNERS,
  SINGLE_TIER_CAPACITY, TWO_TIER_CAPACITY, FINAL_SHARD_INDEX,
  rpcRead, rpcBackoffMs, RPC_ATTEMPTS,
  stuckScoreAction, SCORE_TIMEOUT_SECONDS, SCORE_ATTEMPTS,
  closeRoundAction, formatRemaining,
  lockAction, acquireLock, releaseLock, LOCK_PATH, LOCK_STALE_SECONDS,
};
export type { BracketPlan, ShardPlan, StuckScoreAction, CloseAction, LockAction, LockFile };
