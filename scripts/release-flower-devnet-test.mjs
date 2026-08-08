/**
 * Secret Garden — REAL DEVNET test for `release_flower` (release-to-ACTIVE) and for the
 * breeding-laundering fix in `start_breeding`.
 *
 * What this proves, end to end, on devnet cluster 456 with real Arcium MPC:
 *
 *   1. A bred hybrid submitted to a round goes SUBMITTED and STAYS SUBMITTED.
 *   2. `release_flower` is REJECTED while the round is Open  -> RoundNotFinalized.
 *   3. `release_flower` is REJECTED while the round is Closed -> RoundNotFinalized.
 *      (This is the guard the whole instruction exists for: a flower must not come back
 *      while its round can still be scored/revealed.)
 *   4. After the full score -> bracket reveal -> apply -> finalize cycle, the flower is
 *      STILL SUBMITTED, and `start_breeding` with it as a parent is REJECTED
 *      (FlowerNotActive). Before the fix the guard was `!= LOCKED`, which admitted a
 *      SUBMITTED parent and let `breed_callback` launder it back to ACTIVE mid-round.
 *   5. `release_flower` now SUCCEEDS -> the flower is ACTIVE again, and `total_flowers`
 *      is UNCHANGED (submit_entry never decremented it, so release must not either).
 *   6. Release is ONE-SHOT per entry: replaying round A's finalized entry while the flower
 *      is submitted to the LIVE round B is rejected (EntryAlreadyReleased), so a stale
 *      finalized entry cannot be used to bypass the round gate.
 *   7. The released flower is genuinely usable again:
 *        a. re-breedable  — `start_breeding` succeeds with it as a parent, real MPC
 *           callback lands, and it returns to ACTIVE afterwards;
 *        b. re-submittable — `submit_entry` succeeds in a LATER round;
 *        c. closeable     — after that later round is finalized and the flower released a
 *           SECOND time, `close_flower` succeeds and `total_flowers` finally decrements.
 *
 * Resumable via release-flower-state.json in the scratchpad.
 *
 * Usage:  set -a; source .env; set +a; node scripts/release-flower-devnet-test.mjs
 */
import * as anchor from "@anchor-lang/core";
import * as arcium from "@arcium-hq/client";
import BN from "bn.js";
import { randomBytes } from "crypto";
import fs from "fs";
import os from "os";

const { PublicKey, Keypair, SystemProgram } = anchor.web3;

const RPC = process.env.HELIUS_RPC_URL;
if (!RPC) throw new Error("HELIUS_RPC_URL not set (set -a; source .env; set +a)");
// Resumable run state + log live OUTSIDE the repo: the state file holds the throwaway
// player wallet's secret key, so it must never land in git. Override with SCRATCH=<dir>.
const SCRATCH = process.env.SCRATCH ?? `${os.tmpdir()}/secret-garden-release-flower`;
fs.mkdirSync(SCRATCH, { recursive: true });

const FLOWER_STATUS_ACTIVE = 0,
  FLOWER_STATUS_LOCKED = 1,
  FLOWER_STATUS_SUBMITTED = 2;
const GENOME_STATUS_ENCRYPTED = 1;
const ENTRY_STATUS_SUBMITTED = 0,
  ENTRY_STATUS_RELEASED = 1;
const ROUND_STATUS_OPEN = 0,
  ROUND_STATUS_CLOSED = 1,
  ROUND_STATUS_FINALIZED = 2;
const EXPERIMENT_STATUS_QUEUED = 0,
  EXPERIMENT_STATUS_COMPLETED = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u32le = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

process.env.ARCIUM_CLUSTER_OFFSET = "456";
const conn = new anchor.web3.Connection(RPC, "confirmed");
const authority = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`).toString())),
);
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(authority), {
  commitment: "confirmed",
});
anchor.setProvider(provider);
const IDL = JSON.parse(fs.readFileSync("./target/idl/secret_garden.json").toString());
const program = new anchor.Program(IDL, provider);

/** name -> anchor error code, straight from the freshly built IDL (no hardcoded numbers). */
const ERR = Object.fromEntries(IDL.errors.map((e) => [e.name, e.code]));

const env = arcium.getArciumEnv();
const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId)[0];
const profilePda = (o) =>
  PublicKey.findProgramAddressSync([Buffer.from("profile"), o.toBuffer()], program.programId)[0];
const flowerPda = (o, i) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("flower"), o.toBuffer(), u32le(i)],
    program.programId,
  )[0];
const experimentPda = (o, i) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("experiment"), o.toBuffer(), u32le(i)],
    program.programId,
  )[0];
const roundPda = (id) =>
  PublicKey.findProgramAddressSync([Buffer.from("round"), u64le(id)], program.programId)[0];
const entryPda = (r, p) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("entry"), r.toBuffer(), p.toBuffer()],
    program.programId,
  )[0];
const bracketPda = (r) =>
  PublicKey.findProgramAddressSync([Buffer.from("bracket"), r.toBuffer()], program.programId)[0];
const shardResPda = (r, i) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("shardres"), r.toBuffer(), Buffer.from([i])],
    program.programId,
  )[0];
const compDefAccOf = (c) =>
  arcium.getCompDefAccAddress(
    program.programId,
    Buffer.from(arcium.getCompDefAccOffset(c)).readUInt32LE(),
  );
const queueAccsFor = (c, off) => ({
  computationAccount: arcium.getComputationAccAddress(env.arciumClusterOffset, off),
  clusterAccount: arcium.getClusterAccAddress(env.arciumClusterOffset),
  mxeAccount: arcium.getMXEAccAddress(program.programId),
  mempoolAccount: arcium.getMempoolAccAddress(env.arciumClusterOffset),
  executingPool: arcium.getExecutingPoolAccAddress(env.arciumClusterOffset),
  compDefAccount: compDefAccOf(c),
});
const freshOffset = () => new BN(randomBytes(8), "hex");

const ST = `${SCRATCH}/release-flower-state.json`;
const st = fs.existsSync(ST) ? JSON.parse(fs.readFileSync(ST).toString()) : {};
const save = () => fs.writeFileSync(ST, JSON.stringify(st, null, 1));
const log = (m) => {
  console.log(m);
  fs.appendFileSync(`${SCRATCH}/release-flower.log`, m + "\n");
};

let checks = 0,
  failures = 0;
const check = (ok, msg) => {
  checks++;
  if (!ok) failures++;
  log(`  ${ok ? "PASS" : "**FAIL**"}  ${msg}`);
};

/** Sends and REQUIRES success. Returns the signature. */
async function send(tx, label, signers = [authority]) {
  for (let a = 1; a <= 6; a++) {
    const bh = await conn.getLatestBlockhash({ commitment: "confirmed" });
    tx.recentBlockhash = bh.blockhash;
    tx.lastValidBlockHeight = bh.lastValidBlockHeight;
    tx.feePayer = signers[0].publicKey;
    tx.signatures = [];
    tx.sign(...signers);
    let sig;
    try {
      sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 });
    } catch (e) {
      log(`    ${label} send err: ${String(e.message).slice(0, 100)}`);
      await sleep(1500);
      continue;
    }
    const dl = Date.now() + 90_000;
    while (Date.now() < dl) {
      const s = (await conn.getSignatureStatuses([sig])).value[0];
      if (s) {
        if (s.err) throw new Error(`${label} FAILED: ${JSON.stringify(s.err)} (${sig})`);
        if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") return sig;
      }
      if ((await conn.getBlockHeight({ commitment: "confirmed" })) > bh.lastValidBlockHeight) break;
      await sleep(800);
    }
  }
  throw new Error(`${label} did not confirm`);
}

/**
 * Sends a transaction that MUST be rejected on-chain, and asserts the anchor error code.
 * Deliberately a REAL submitted transaction (skipPreflight) rather than a simulation, so
 * the rejection is proven by the on-chain runtime, not by a local dry run.
 */
async function sendExpectFail(tx, label, signers, expectedName) {
  const expected = ERR[expectedName];
  if (expected === undefined) throw new Error(`unknown error name ${expectedName}`);
  for (let a = 1; a <= 6; a++) {
    const bh = await conn.getLatestBlockhash({ commitment: "confirmed" });
    tx.recentBlockhash = bh.blockhash;
    tx.lastValidBlockHeight = bh.lastValidBlockHeight;
    tx.feePayer = signers[0].publicKey;
    tx.signatures = [];
    tx.sign(...signers);
    let sig;
    try {
      sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 });
    } catch (e) {
      log(`    ${label} send err: ${String(e.message).slice(0, 100)}`);
      await sleep(1500);
      continue;
    }
    const dl = Date.now() + 90_000;
    while (Date.now() < dl) {
      const s = (await conn.getSignatureStatuses([sig])).value[0];
      if (s) {
        if (!s.err) {
          check(false, `${label}: expected ${expectedName}(${expected}) but the tx SUCCEEDED (${sig})`);
          return null;
        }
        const custom = s.err?.InstructionError?.[1]?.Custom;
        check(
          custom === expected,
          `${label}: rejected on-chain with ${custom} (expected ${expectedName}=${expected})`,
        );
        return custom;
      }
      if ((await conn.getBlockHeight({ commitment: "confirmed" })) > bh.lastValidBlockHeight) break;
      await sleep(800);
    }
  }
  throw new Error(`${label} did not land (neither success nor failure)`);
}

// --- MXE cipher (needed for start_breeding's encrypted inputs) ---------------
let cipher, x25519Pub;
{
  let key = null;
  for (let i = 0; i < 90 && !key; i++) {
    try {
      key = await arcium.getMXEPublicKey(provider, program.programId);
    } catch {}
    if (!key) await sleep(1000);
  }
  if (!key) throw new Error("no MXE key");
  const priv = arcium.x25519.utils.randomSecretKey();
  x25519Pub = arcium.x25519.getPublicKey(priv);
  cipher = new arcium.RescueCipher(arcium.x25519.getSharedSecret(priv, key));
}

const startBal = await conn.getBalance(authority.publicKey);
log(`\n######## release_flower — REAL DEVNET FULL-CYCLE TEST ########`);
log(`program   ${program.programId.toBase58()}`);
log(`authority ${authority.publicKey.toBase58()}  balance ${(startBal / 1e9).toFixed(4)} SOL`);
log(
  `codes: RoundNotFinalized=${ERR.RoundNotFinalized} FlowerNotSubmitted=${ERR.FlowerNotSubmitted} ` +
    `FlowerNotActive=${ERR.FlowerNotActive} EntryMismatch=${ERR.EntryMismatch} ` +
    `EntryAlreadyReleased=${ERR.EntryAlreadyReleased}`,
);

// ===========================================================================
// PHASE 0 — a fresh player wallet with a profile + starters
// ===========================================================================
if (!st.player) {
  st.player = Array.from(Keypair.generate().secretKey);
  save();
}
const player = Keypair.fromSecretKey(new Uint8Array(st.player));
log(`\n[0] player ${player.publicKey.toBase58()}`);
if ((await conn.getBalance(player.publicKey)) < 120_000_000) {
  await send(
    new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: player.publicKey,
        lamports: 300_000_000,
      }),
    ),
    "fund player",
  );
}
if (!(await conn.getAccountInfo(profilePda(player.publicKey)))) {
  await send(
    await program.methods
      .createProfile()
      .accountsPartial({
        owner: player.publicKey,
        config: configPda,
        profile: profilePda(player.publicKey),
      })
      .transaction(),
    "createProfile",
    [player],
  );
}
if (!(await conn.getAccountInfo(flowerPda(player.publicKey, 0)))) {
  const f = (j) => flowerPda(player.publicKey, j);
  await send(
    await program.methods
      .claimStarters()
      .accountsPartial({
        owner: player.publicKey,
        config: configPda,
        profile: profilePda(player.publicKey),
        flower0: f(0),
        flower1: f(1),
        flower2: f(2),
        flower3: f(3),
        flower4: f(4),
        flower5: f(5),
      })
      .transaction(),
    "claimStarters",
    [player],
  );
}
log(`    profile + 6 starters ready`);

/** Breeds parentA x parentB into a fresh offspring PDA and waits for the real MPC callback. */
async function breed(parentA, parentB, label) {
  const prof = await program.account.playerProfile.fetch(profilePda(player.publicKey));
  const experiment = experimentPda(player.publicKey, prof.totalExperiments);
  const offspring = flowerPda(player.publicKey, prof.nextFlowerIndex);
  const off = freshOffset();
  const nonce = randomBytes(16);
  const ct = cipher.encrypt([BigInt(40), BigInt(120), BigInt(200)], nonce);
  await send(
    await program.methods
      .startBreeding(
        off,
        Array.from(x25519Pub),
        new BN(arcium.deserializeLE(nonce).toString()),
        Array.from(ct[0]),
        Array.from(ct[1]),
        Array.from(ct[2]),
      )
      .accountsPartial({
        player: player.publicKey,
        profile: profilePda(player.publicKey),
        flowerA: parentA,
        flowerB: parentB,
        experiment,
        offspring,
        ...queueAccsFor("breed", off),
      })
      .transaction(),
    label,
    [player],
  );
  await arcium.awaitComputationFinalization(provider, off, program.programId, "confirmed", 360000);
  for (let k = 0; k < 200; k++) {
    const e = await program.account.experiment.fetch(experiment);
    if (e.status === EXPERIMENT_STATUS_COMPLETED) break;
    if (e.status !== EXPERIMENT_STATUS_QUEUED) throw new Error(`${label}: experiment status ${e.status}`);
    await sleep(1500);
  }
  return offspring;
}

/** Builds an (unsigned) start_breeding transaction WITHOUT sending — for reject tests. */
async function breedTx(parentA, parentB) {
  const prof = await program.account.playerProfile.fetch(profilePda(player.publicKey));
  const off = freshOffset();
  const nonce = randomBytes(16);
  const ct = cipher.encrypt([BigInt(40), BigInt(120), BigInt(200)], nonce);
  return program.methods
    .startBreeding(
      off,
      Array.from(x25519Pub),
      new BN(arcium.deserializeLE(nonce).toString()),
      Array.from(ct[0]),
      Array.from(ct[1]),
      Array.from(ct[2]),
    )
    .accountsPartial({
      player: player.publicKey,
      profile: profilePda(player.publicKey),
      flowerA: parentA,
      flowerB: parentB,
      experiment: experimentPda(player.publicKey, prof.totalExperiments),
      offspring: flowerPda(player.publicKey, prof.nextFlowerIndex),
      ...queueAccsFor("breed", off),
    })
    .transaction();
}

// ===========================================================================
// PHASE 1 — breed the hybrid under test (starter0 x starter1)
// ===========================================================================
log(`\n[1] breed the hybrid under test`);
if (!st.hybrid) {
  const h = await breed(
    flowerPda(player.publicKey, 0),
    flowerPda(player.publicKey, 1),
    "breed hybrid",
  );
  st.hybrid = h.toBase58();
  save();
}
const hybrid = new PublicKey(st.hybrid);
{
  const f = await program.account.flowerRecord.fetch(hybrid);
  check(
    f.status === FLOWER_STATUS_ACTIVE && f.genomeStatus === GENOME_STATUS_ENCRYPTED,
    `bred hybrid ${hybrid.toBase58().slice(0, 8)}… is ACTIVE + ENCRYPTED (gen ${f.generation})`,
  );
}
const flowersAfterBreed = (await program.account.playerProfile.fetch(profilePda(player.publicKey)))
  .totalFlowers;
log(`    profile.total_flowers = ${flowersAfterBreed}`);

/** Drives the whole round lifecycle for a 1-entry round and returns the round PDA. */
async function runRoundCycle(stateKey, phaseLabel, onOpen, onClosed) {
  // Every previous round must be Finalized before a new one may open.
  const cfg = await program.account.gameConfig.fetch(configPda);
  const cur = cfg.currentRound.toNumber();
  if (!st[stateKey]) {
    const prev = roundPda(cur);
    if (await conn.getAccountInfo(prev)) {
      const r0 = await program.account.competitionRound.fetch(prev);
      if (r0.status === ROUND_STATUS_OPEN) {
        await send(
          await program.methods
            .closeRound()
            .accountsPartial({ authority: authority.publicKey, config: configPda, round: prev })
            .transaction(),
          `closeRound(prev ${cur})`,
        );
      }
      const r1 = await program.account.competitionRound.fetch(prev);
      if (r1.status === ROUND_STATUS_CLOSED) {
        await send(
          await program.methods
            .finalizeRound()
            .accountsPartial({ authority: authority.publicKey, config: configPda, round: prev })
            .transaction(),
          `finalizeRound(prev ${cur})`,
        );
      }
    }
    st[stateKey] = cur + 1;
    save();
    await send(
      await program.methods
        .openRound()
        .accountsPartial({
          authority: authority.publicKey,
          config: configPda,
          previousRound: cur > 0 ? roundPda(cur) : null,
          round: roundPda(st[stateKey]),
        })
        .transaction(),
      `openRound(${st[stateKey]})`,
    );
  }
  const round = roundPda(st[stateKey]);
  const entry = entryPda(round, player.publicKey);
  log(`${phaseLabel} round ${st[stateKey]}  ${round.toBase58().slice(0, 8)}…`);

  // --- submit ---
  if (!(await conn.getAccountInfo(entry))) {
    await send(
      await program.methods
        .submitEntry()
        .accountsPartial({
          player: player.publicKey,
          config: configPda,
          profile: profilePda(player.publicKey),
          round,
          flowerRecord: hybrid,
          entry,
        })
        .transaction(),
      `submitEntry(round ${st[stateKey]})`,
      [player],
    );
  }
  if (onOpen) await onOpen(round, entry);

  // --- close ---
  let r = await program.account.competitionRound.fetch(round);
  if (r.status === ROUND_STATUS_OPEN) {
    await send(
      await program.methods
        .closeRound()
        .accountsPartial({ authority: authority.publicKey, config: configPda, round })
        .transaction(),
      `closeRound(${st[stateKey]})`,
    );
  }
  if (onClosed) await onClosed(round, entry);

  // --- score (real MPC) ---
  if (!(await program.account.competitionEntry.fetch(entry)).scored) {
    const off = freshOffset();
    await send(
      await program.methods
        .queueScoreEntry(off)
        .accountsPartial({
          authority: authority.publicKey,
          config: configPda,
          round,
          entry,
          flowerRecord: hybrid,
          ...queueAccsFor("score_entry_v2", off),
        })
        .transaction(),
      `queueScoreEntry(${st[stateKey]})`,
    );
    await arcium.awaitComputationFinalization(provider, off, program.programId, "confirmed", 360000);
    for (let k = 0; k < 200; k++) {
      if ((await program.account.competitionEntry.fetch(entry)).scored) break;
      await sleep(1500);
    }
  }
  log(`    scored`);

  // --- bracket reveal (single shard of 1; MIN_SHARD_SIZE is 1) ---
  const bracket = bracketPda(round);
  const b0 = await program.account.bracketState.fetchNullable(bracket);
  if (!b0 || !b0.applied) {
    if (!b0 || b0.shardCount !== 1) {
      const sizes = [1, 0, 0, 0];
      const bounds = [entry, PublicKey.default, PublicKey.default, PublicKey.default];
      await send(
        await program.methods
          .initBracket(sizes, bounds, 1)
          .accountsPartial({ authority: authority.publicKey, config: configPda, round, bracket })
          .transaction(),
        `initBracket(${st[stateKey]})`,
      );
    }
    const rem = [{ pubkey: entry, isWritable: false, isSigner: false }];
    const existing = await program.account.revealTop3V3Result.fetchNullable(shardResPda(round, 0));
    const bNow = await program.account.bracketState.fetch(bracket);
    if (!existing?.ready || existing.generation !== bNow.generation) {
      const off = freshOffset();
      await send(
        await program.methods
          .queueShardReveal(off, 0)
          .accountsPartial({
            authority: authority.publicKey,
            config: configPda,
            round,
            bracket,
            result: shardResPda(round, 0),
            ...queueAccsFor("reveal_top3_v3", off),
          })
          .remainingAccounts(rem)
          .transaction(),
        `queueShardReveal(${st[stateKey]})`,
      );
      await arcium.awaitComputationFinalization(provider, off, program.programId, "confirmed", 360000);
      for (let k = 0; k < 200; k++) {
        const s = await program.account.revealTop3V3Result.fetchNullable(shardResPda(round, 0));
        if (s?.ready) break;
        await sleep(1500);
      }
    }
    const bb = await program.account.bracketState.fetch(bracket);
    if ((bb.shardsCollected & 1) === 0) {
      await send(
        await program.methods
          .collectShardWinners(0)
          .accountsPartial({
            authority: authority.publicKey,
            config: configPda,
            round,
            bracket,
            result: shardResPda(round, 0),
          })
          .remainingAccounts(rem)
          .transaction(),
        `collectShardWinners(${st[stateKey]})`,
      );
    }
    if (!(await program.account.bracketState.fetch(bracket)).applied) {
      await send(
        await program.methods
          .applyBracketResult(0)
          .accountsPartial({
            authority: authority.publicKey,
            config: configPda,
            round,
            bracket,
            result: shardResPda(round, 0),
          })
          .transaction(),
        `applyBracketResult(${st[stateKey]})`,
      );
    }
  }
  r = await program.account.competitionRound.fetch(round);
  log(`    revealed=${r.scoringRevealed}  top1=${r.top1.toBase58().slice(0, 8)}…`);

  // --- finalize ---
  if (r.status === ROUND_STATUS_CLOSED) {
    await send(
      await program.methods
        .finalizeRound()
        .accountsPartial({ authority: authority.publicKey, config: configPda, round })
        .transaction(),
      `finalizeRound(${st[stateKey]})`,
    );
  }
  r = await program.account.competitionRound.fetch(round);
  check(r.status === ROUND_STATUS_FINALIZED, `round ${st[stateKey]} is FINALIZED`);
  return { round, entry };
}

const releaseTx = (round, entry) =>
  program.methods
    .releaseFlower()
    .accountsPartial({
      owner: player.publicKey,
      config: configPda,
      round,
      entry,
      flower: hybrid,
    })
    .transaction();

// ===========================================================================
// PHASE 2 — round A: submit, prove the early-release guard, run the full cycle
// ===========================================================================
log(`\n[2] ROUND A — submit + guard checks + full score/reveal/finalize cycle`);
const { round: roundA, entry: entryA } = await runRoundCycle(
  "roundA",
  "   ",
  // while the round is still OPEN
  async (round, entry) => {
    const f = await program.account.flowerRecord.fetch(hybrid);
    check(f.status === FLOWER_STATUS_SUBMITTED, `after submit_entry the flower is SUBMITTED`);
    await sendExpectFail(
      await releaseTx(round, entry),
      "release_flower while round OPEN",
      [player],
      "RoundNotFinalized",
    );
  },
  // while the round is CLOSED but NOT yet finalized  <-- the required guard test
  async (round, entry) => {
    const r = await program.account.competitionRound.fetch(round);
    check(r.status === ROUND_STATUS_CLOSED, `round A is CLOSED (status ${r.status}), not finalized`);
    await sendExpectFail(
      await releaseTx(round, entry),
      "release_flower while round CLOSED (not finalized)",
      [player],
      "RoundNotFinalized",
    );
  },
);

// ===========================================================================
// PHASE 3 — post-finalize: still SUBMITTED, and NOT breedable (the fix)
// ===========================================================================
log(`\n[3] after finalize: flower must still be SUBMITTED and NOT breedable`);
{
  const f = await program.account.flowerRecord.fetch(hybrid);
  check(
    f.status === FLOWER_STATUS_SUBMITTED,
    `flower is STILL SUBMITTED after the round finalized (status ${f.status})`,
  );
}
await sendExpectFail(
  await breedTx(hybrid, flowerPda(player.publicKey, 2)),
  "start_breeding with the SUBMITTED flower as parent A",
  [player],
  "FlowerNotActive",
);
await sendExpectFail(
  await breedTx(flowerPda(player.publicKey, 2), hybrid),
  "start_breeding with the SUBMITTED flower as parent B",
  [player],
  "FlowerNotActive",
);
// close_flower must also still refuse it (it requires ACTIVE).
await sendExpectFail(
  await program.methods
    .closeFlower()
    .accountsPartial({
      owner: player.publicKey,
      config: configPda,
      profile: profilePda(player.publicKey),
      flower: hybrid,
    })
    .transaction(),
  "close_flower on the SUBMITTED flower",
  [player],
  "FlowerNotActive",
);

// ===========================================================================
// PHASE 4 — release_flower succeeds; flower is ACTIVE; total_flowers untouched
// ===========================================================================
log(`\n[4] release_flower`);
const flowersBeforeRelease = (
  await program.account.playerProfile.fetch(profilePda(player.publicKey))
).totalFlowers;
await send(await releaseTx(roundA, entryA), "releaseFlower(round A)", [player]);
{
  const f = await program.account.flowerRecord.fetch(hybrid);
  check(f.status === FLOWER_STATUS_ACTIVE, `flower is back to ACTIVE (status ${f.status})`);
  const p = await program.account.playerProfile.fetch(profilePda(player.publicKey));
  check(
    p.totalFlowers === flowersBeforeRelease,
    `total_flowers UNCHANGED by release (${flowersBeforeRelease} -> ${p.totalFlowers})`,
  );
  const e = await program.account.competitionEntry.fetch(entryA);
  check(
    e.flowerRecord.equals(hybrid) && e.round.equals(roundA),
    `the round's entry record is left intact (still names the flower + round)`,
  );
}
// A second release must now fail: the entry's release right is spent (and the flower is no
// longer SUBMITTED either — `entry` is declared first, so its error surfaces).
await sendExpectFail(
  await releaseTx(roundA, entryA),
  "release_flower a second time on the same flower",
  [player],
  "EntryAlreadyReleased",
);
{
  const e = await program.account.competitionEntry.fetch(entryA);
  check(e.status === ENTRY_STATUS_RELEASED, `round A's entry is marked RELEASED (status ${e.status})`);
}

// ===========================================================================
// PHASE 5a — re-breedable
// ===========================================================================
log(`\n[5a] the released flower is RE-BREEDABLE`);
if (!st.hybrid2) {
  const h2 = await breed(hybrid, flowerPda(player.publicKey, 2), "breed with released flower");
  st.hybrid2 = h2.toBase58();
  save();
}
{
  const child = await program.account.flowerRecord.fetch(new PublicKey(st.hybrid2));
  check(
    child.status === FLOWER_STATUS_ACTIVE && child.genomeStatus === GENOME_STATUS_ENCRYPTED,
    `start_breeding SUCCEEDED with the released flower as a parent -> offspring ${st.hybrid2.slice(0, 8)}… ACTIVE+ENCRYPTED`,
  );
  const f = await program.account.flowerRecord.fetch(hybrid);
  check(
    f.status === FLOWER_STATUS_ACTIVE,
    `the released parent is ACTIVE again after the breed callback (status ${f.status})`,
  );
}

// ===========================================================================
// PHASE 5b — re-submittable in a LATER round; then release + close
// ===========================================================================
log(`\n[5b] the released flower is RE-SUBMITTABLE in a later round`);
const { round: roundB, entry: entryB } = await runRoundCycle("roundB", "   ", async () => {
  const f = await program.account.flowerRecord.fetch(hybrid);
  check(
    f.status === FLOWER_STATUS_SUBMITTED,
    `submit_entry SUCCEEDED in the later round -> flower SUBMITTED again`,
  );

  // THE REPLAY. Round A is Finalized forever and its entry still names this flower, which
  // is Submitted again — so every constraint except the one-shot entry flag passes here.
  // Without that flag this would SUCCEED and yank the flower straight out of the LIVE
  // round B, defeating the round gate (and from there close_flower would delete a flower
  // round B still has to score, leaving round B permanently unrevealable).
  await sendExpectFail(
    await releaseTx(roundA, entryA),
    "REPLAY: round A's finalized entry against the live round B",
    [player],
    "EntryAlreadyReleased",
  );
  const after = await program.account.flowerRecord.fetch(hybrid);
  check(
    after.status === FLOWER_STATUS_SUBMITTED,
    `the flower stayed SUBMITTED to the live round B after the replay attempt`,
  );
});

log(`\n[5c] release again, then close_flower`);
await send(await releaseTx(roundB, entryB), "releaseFlower(round B)", [player]);
{
  const f = await program.account.flowerRecord.fetch(hybrid);
  check(f.status === FLOWER_STATUS_ACTIVE, `second release also returns the flower to ACTIVE`);
}
const before = await program.account.playerProfile.fetch(profilePda(player.publicKey));
const ownerBalBefore = await conn.getBalance(player.publicKey);
await send(
  await program.methods
    .closeFlower()
    .accountsPartial({
      owner: player.publicKey,
      config: configPda,
      profile: profilePda(player.publicKey),
      flower: hybrid,
    })
    .transaction(),
  "closeFlower(released flower)",
  [player],
);
{
  const after = await program.account.playerProfile.fetch(profilePda(player.publicKey));
  const gone = (await conn.getAccountInfo(hybrid)) === null;
  const ownerBalAfter = await conn.getBalance(player.publicKey);
  check(gone, `close_flower SUCCEEDED — the flower account is closed`);
  check(
    after.totalFlowers === before.totalFlowers - 1,
    `total_flowers decremented exactly once by close (${before.totalFlowers} -> ${after.totalFlowers})`,
  );
  check(
    ownerBalAfter > ownerBalBefore,
    `rent refunded to the owner (+${((ownerBalAfter - ownerBalBefore) / 1e9).toFixed(6)} SOL net of fee)`,
  );
}

// ===========================================================================
// verdict
// ===========================================================================
const endBal = await conn.getBalance(authority.publicKey);
const playerBal = await conn.getBalance(player.publicKey);
log(`\n######## VERDICT ########`);
log(`checks: ${checks - failures}/${checks} passed`);
log(
  `authority spend: ${((startBal - endBal) / 1e9).toFixed(6)} SOL ` +
    `(includes the ${(300_000_000 / 1e9).toFixed(3)} SOL funded to the player; ${(playerBal / 1e9).toFixed(6)} SOL still sits in the player wallet)`,
);
log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
