/**
 * Secret Garden — DEVNET resilient circuit uploader (resumable, rate-limit-safe).
 *
 * WHY THIS EXISTS
 * ---------------
 * The stock `@arcium-hq/client` `uploadCircuit()` has two properties that broke the
 * first breed upload (see the post-429 recovery notes):
 *   1. `chunkSize` is the number of upload txs fired *in parallel* via Promise.all
 *      (default 500). 539 concurrent sends to a single RPC => HTTP 429 mid-upload.
 *   2. It reuses ONE blockhash for all 539 txs (~60s validity), AND it SKIPS a raw
 *      circuit account entirely if that account already exists at full size — even if
 *      the data inside is incomplete. After the 429, breed's raw[0] account is fully
 *      allocated (438017 B) but only ~82% written (last ~77 KB are zeros). A naive
 *      re-run would SKIP the upload and then FINALIZE a circuit with 77 KB of zeros.
 *
 * This uploader fixes both:
 *   - Diffs the on-chain raw-circuit bytes against the local build/<circuit>.arcis and
 *     uploads ONLY the 814-byte chunks that differ (covers the missing tail + any
 *     corrupted chunk). Bypasses the broken account-size skip.
 *   - Low, bounded concurrency (default 8) with a FRESH blockhash per retry and
 *     exponential backoff on 429 / blockhash-expiry, plus a small inter-batch delay.
 *   - Verifies the full account byte-for-byte BEFORE finalizing. Refuses to finalize a
 *     mismatched circuit.
 *
 * SAFE BY DEFAULT: dry-run unless UPLOAD_EXECUTE=yes. Dry-run sends nothing and prints
 * exactly which chunks it would upload.
 *
 *   # dry run (read-only, free):
 *   CIRCUIT=breed ANCHOR_PROVIDER_URL=$HELIUS_RPC_URL ANCHOR_WALLET=<wallet> \
 *     ARCIUM_CLUSTER_OFFSET=456 npx mocha --no-config --timeout 120000 \
 *     scripts/devnet-upload-circuit.ts
 *
 *   # real upload (SPENDS devnet SOL):
 *   UPLOAD_EXECUTE=yes CIRCUIT=breed CONCURRENCY=8 ANCHOR_PROVIDER_URL=$HELIUS_RPC_URL \
 *     ANCHOR_WALLET=<wallet> ARCIUM_CLUSTER_OFFSET=456 \
 *     npx mocha --no-config --timeout 1800000 scripts/devnet-upload-circuit.ts
 */
import * as anchor from "@anchor-lang/core";
import * as arcium from "@arcium-hq/client";
import * as fs from "fs";
import type { SecretGarden } from "../target/types/secret_garden";

const { PublicKey } = anchor.web3;

// Mirror the SDK constants (node_modules/@arcium-hq/client/src/constants.ts).
const MAX_UPLOAD_PER_TX_BYTES = 814;
const MAX_ACCOUNT_SIZE = 10485760;
const MAX_REALLOC_PER_IX = 10240;
const MAX_EMBIGGEN_IX_PER_TX = 18;
const RAW_HEADER = 9; // 8-byte discriminator + 1-byte bump

const CIRCUIT = (process.env.CIRCUIT ?? "breed") as
  | "breed" | "score_entry" | "reveal_top3";
const EXECUTE = process.env.UPLOAD_EXECUTE === "yes";
const CONCURRENCY = Number(process.env.CONCURRENCY ?? "8");
const INTER_BATCH_DELAY_MS = Number(process.env.INTER_BATCH_DELAY_MS ?? "250");
const MAX_RETRIES = Number(process.env.MAX_RETRIES ?? "7");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe(`secret-garden DEVNET resilient upload: ${CIRCUIT} (execute=${EXECUTE})`, () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.SecretGarden as anchor.Program<SecretGarden>;
  const arciumProgram = arcium.getArciumProgram(provider);
  const conn = provider.connection;
  const programId = program.programId;
  const signer = provider.wallet.publicKey;

  const offsetNum = Buffer.from(arcium.getCompDefAccOffset(CIRCUIT)).readUInt32LE();
  const compDefPda = PublicKey.findProgramAddressSync(
    [arcium.getArciumAccountBaseSeed("ComputationDefinitionAccount"), programId.toBuffer(),
      arcium.getCompDefAccOffset(CIRCUIT)],
    arcium.getArciumProgramId(),
  )[0];
  const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
  const INIT_METHOD: Record<string, string> = {
    breed: "initBreedingCompDef",
    score_entry: "initScoreEntryCompDef",
    reveal_top3: "initRevealTop3CompDef",
  };

  it(`uploads/repairs ${CIRCUIT} circuit and finalizes`, async function () {
    this.timeout(1_800_000);

    const local = fs.readFileSync(`build/${CIRCUIT}.arcis`);
    const numAccs = Math.ceil(local.length / (MAX_ACCOUNT_SIZE - RAW_HEADER));
    console.log(`\n[${CIRCUIT}] localLen=${local.length}  numAccs=${numAccs}  signer=${signer.toBase58()}`);
    console.log(`comp-def: ${compDefPda.toBase58()} (offset=${offsetNum})`);

    // --- comp-def: register if missing (HTTP); skip if already finalized ---
    const compDefInfo = { pubkey: compDefPda, offset: offsetNum };
    let cdInfo = await conn.getAccountInfo(compDefPda);
    if (!cdInfo) {
      const method = INIT_METHOD[CIRCUIT];
      console.log(`comp-def NOT registered -> ${EXECUTE ? "registering" : "would register"} via ${method}`);
      if (EXECUTE) {
        const mxeAccount = arcium.getMXEAccAddress(programId);
        const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
        const tx = await (program.methods as any)[method]()
          .accountsPartial({
            authority: signer,
            config: configPda,
            compDefAccount: compDefPda,
            mxeAccount,
            addressLookupTable: arcium.getLookupTableAddress(programId, mxeAcc.lutOffsetSlot),
          }).transaction();
        await sendOne(tx, `register ${CIRCUIT} comp-def`);
        cdInfo = await conn.getAccountInfo(compDefPda);
      }
    }
    if (cdInfo) {
      const cd: any = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPda);
      const cs = cd.circuitSource;
      if (!cs?.onChain) throw new Error(`comp-def circuitSource is not OnChain: ${JSON.stringify(cs)}`);
      const alreadyCompleted = cs.onChain[0].isCompleted;
      console.log(`comp-def onChain.isCompleted=${alreadyCompleted}`);
      if (alreadyCompleted) {
        console.log(`Circuit already finalized on-chain. Nothing to do.`);
        return;
      }
    }

    // We only support the single-account case here (true for all 3 circuits: <10MB).
    if (numAccs !== 1) throw new Error(`Expected 1 raw account, got ${numAccs}; extend script.`);

    const rawIndex = 0;
    const part = local.subarray(0, MAX_ACCOUNT_SIZE - RAW_HEADER); // == whole file
    const rawPda = arcium.getRawCircuitAccAddress(compDefPda, rawIndex);
    let rawInfo = await conn.getAccountInfo(rawPda);

    // --- ensure raw account exists and is large enough (init + resize if needed) ---
    const requiredDataLen = part.length + RAW_HEADER;
    if (!rawInfo) {
      console.log(`raw[${rawIndex}] missing -> would init + resize`);
      if (EXECUTE) {
        const initTx = await arciumProgram.methods
          .initRawCircuitAcc(compDefInfo.offset, programId, rawIndex)
          .accounts({ signer }).transaction();
        await sendOne(initTx, "initRawCircuitAcc");
        rawInfo = await conn.getAccountInfo(rawPda);
      }
    }
    let currentLen = rawInfo ? rawInfo.data.length : RAW_HEADER;
    while (currentLen < requiredDataLen) {
      const grow = Math.min(requiredDataLen - currentLen, MAX_EMBIGGEN_IX_PER_TX * MAX_REALLOC_PER_IX);
      const ixCount = Math.ceil(grow / MAX_REALLOC_PER_IX);
      console.log(`resize: ${currentLen} -> +${grow} (${ixCount} embiggen ix)`);
      if (EXECUTE) {
        const ix = await arciumProgram.methods
          .embiggenRawCircuitAcc(compDefInfo.offset, programId, rawIndex)
          .accounts({ signer }).instruction();
        const tx = new anchor.web3.Transaction();
        for (let i = 0; i < ixCount; i++) tx.add(ix);
        await sendOne(tx, "resize");
        rawInfo = await conn.getAccountInfo(rawPda);
        currentLen = rawInfo!.data.length;
      } else {
        break; // dry-run: don't loop forever
      }
    }

    // --- diff on-chain bytes vs local, per 814-byte chunk ---
    const onchainData = rawInfo ? rawInfo.data.subarray(RAW_HEADER) : Buffer.alloc(0);
    const totalChunks = Math.ceil(part.length / MAX_UPLOAD_PER_TX_BYTES);
    const dirty: number[] = [];
    for (let c = 0; c < totalChunks; c++) {
      const start = c * MAX_UPLOAD_PER_TX_BYTES;
      const end = Math.min(start + MAX_UPLOAD_PER_TX_BYTES, part.length);
      const want = part.subarray(start, end);
      const have = onchainData.subarray(start, Math.min(end, onchainData.length));
      if (have.length < want.length || !want.equals(have)) dirty.push(c);
    }
    console.log(`\nchunks: total=${totalChunks} alreadyCorrect=${totalChunks - dirty.length} needUpload=${dirty.length}`);
    if (dirty.length) {
      const first = dirty[0], last = dirty[dirty.length - 1];
      console.log(`dirty chunk range: [${first}..${last}]  (bytes ~${first * MAX_UPLOAD_PER_TX_BYTES}..${part.length})`);
    }

    if (!EXECUTE) {
      console.log(`\n[DRY RUN] would upload ${dirty.length} chunk-tx + 1 finalize-tx. Set UPLOAD_EXECUTE=yes to send.\n`);
      return;
    }

    // --- upload dirty chunks: batched send-then-confirm (HTTP only, no websockets) ---
    // Each batch shares one blockhash: send all raw, then poll statuses for the whole
    // batch within that blockhash's validity window. Failed/unconfirmed chunks are
    // requeued for the next round with a fresh blockhash. Upload is idempotent (same
    // bytes at same offset), so a duplicate landing on retry is harmless.
    let worklist = [...dirty];
    let confirmedTotal = 0;
    for (let round = 0; round < MAX_RETRIES && worklist.length; round++) {
      console.log(`\n-- round ${round + 1}: ${worklist.length} chunk(s) to send (concurrency ${CONCURRENCY}) --`);
      const failed: number[] = [];
      for (let i = 0; i < worklist.length; i += CONCURRENCY) {
        const batch = worklist.slice(i, i + CONCURRENCY);
        const bh = await conn.getLatestBlockhash({ commitment: "confirmed" });
        const entries: { chunk: number; sig: string }[] = [];
        await Promise.all(batch.map(async (c) => {
          try {
            const sig = await sendRawChunk(c, part, compDefInfo, rawIndex, bh);
            entries.push({ chunk: c, sig });
          } catch (e) {
            failed.push(c);
            console.log(`    send err chunk ${c}: ${(e as Error).message.slice(0, 80)}`);
          }
        }));
        const res = await confirmBatch(entries, bh.lastValidBlockHeight);
        confirmedTotal += res.confirmed;
        failed.push(...res.failed);
        process.stdout.write(`  confirmed ${confirmedTotal}/${dirty.length} (round ${round + 1}, batch@chunk ${batch[batch.length - 1]}${res.failed.length ? `, ${res.failed.length} requeued` : ""})\n`);
        await sleep(INTER_BATCH_DELAY_MS);
      }
      worklist = [...new Set(failed)];
      if (worklist.length) {
        const backoff = Math.min(8000, 500 * 2 ** round);
        console.log(`  round ${round + 1} leftover: ${worklist.length} chunk(s); backoff ${backoff}ms`);
        await sleep(backoff);
      }
    }
    if (worklist.length) throw new Error(`upload incomplete: ${worklist.length} chunk(s) never confirmed after ${MAX_RETRIES} rounds`);

    // --- VERIFY full account matches local before finalize ---
    const after = await conn.getAccountInfo(rawPda);
    const afterData = after!.data.subarray(RAW_HEADER, RAW_HEADER + part.length);
    if (!Buffer.from(afterData).equals(part)) {
      // find first mismatch for diagnostics
      let m = -1;
      for (let b = 0; b < part.length; b++) if (afterData[b] !== part[b]) { m = b; break; }
      throw new Error(`POST-UPLOAD VERIFY FAILED: on-chain != local at byte ${m}. NOT finalizing.`);
    }
    console.log(`\nVERIFY OK: on-chain raw circuit matches local byte-for-byte (${part.length} B).`);

    // --- finalize ---
    console.log(`finalizing comp-def...`);
    const finalizeTx = await arciumProgram.methods
      .finalizeComputationDefinition(compDefInfo.offset, programId)
      .accounts({ signer }).transaction();
    await sendOne(finalizeTx, "finalize");

    const cd2: any = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPda);
    const done = cd2.circuitSource?.onChain?.[0]?.isCompleted;
    console.log(`comp-def onChain.isCompleted=${done}`);
    if (!done) throw new Error(`finalize did not flip isCompleted; investigate.`);
    console.log(`\n[${CIRCUIT}] UPLOAD + FINALIZE COMPLETE.\n`);
  });

  // ---- helpers (HTTP-only: sign + sendRawTransaction + poll, no websockets) ----

  // Build, sign, and fire one upload-chunk tx with the given blockhash. Returns the
  // signature WITHOUT waiting for confirmation (caller batch-confirms via polling).
  async function sendRawChunk(
    c: number,
    part: Buffer,
    compDefInfo: { pubkey: anchor.web3.PublicKey; offset: number },
    rawIndex: number,
    bh: anchor.web3.BlockhashWithExpiryBlockHeight,
  ): Promise<string> {
    const start = c * MAX_UPLOAD_PER_TX_BYTES;
    const end = Math.min(start + MAX_UPLOAD_PER_TX_BYTES, part.length);
    const padded = Buffer.alloc(MAX_UPLOAD_PER_TX_BYTES); // zero-filled (R-01 safe)
    part.copy(padded, 0, start, end);
    const tx = await arciumProgram.methods
      .uploadCircuit(compDefInfo.offset, programId, rawIndex, Array.from(padded), start)
      .accounts({ signer }).transaction();
    return sendRaw(tx, bh);
  }

  async function sendRaw(
    tx: anchor.web3.Transaction,
    bh: anchor.web3.BlockhashWithExpiryBlockHeight,
  ): Promise<string> {
    tx.recentBlockhash = bh.blockhash;
    tx.lastValidBlockHeight = bh.lastValidBlockHeight;
    tx.feePayer = signer;
    tx.signatures = [];
    const signed = await (provider.wallet as anchor.Wallet).signTransaction(tx);
    return conn.sendRawTransaction(signed.serialize(), {
      skipPreflight: true,
      maxRetries: 0,
      preflightCommitment: "confirmed",
    });
  }

  // Poll signature statuses for a whole batch over HTTP until each is confirmed,
  // errored, or the blockhash expires (block height exceeded). Returns counts and the
  // chunks that must be retried.
  async function confirmBatch(
    entries: { chunk: number; sig: string }[],
    lastValidBlockHeight: number,
  ): Promise<{ confirmed: number; failed: number[] }> {
    const pending = new Map<string, number>(entries.map((e) => [e.sig, e.chunk]));
    const failed: number[] = [];
    let confirmed = 0;
    const deadline = Date.now() + 90_000;
    while (pending.size > 0 && Date.now() < deadline) {
      const sigs = [...pending.keys()];
      const statuses = await conn.getSignatureStatuses(sigs);
      statuses.value.forEach((st, idx) => {
        const sig = sigs[idx];
        if (!st) return;
        if (st.err) { failed.push(pending.get(sig)!); pending.delete(sig); return; }
        if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") {
          confirmed++; pending.delete(sig);
        }
      });
      if (pending.size === 0) break;
      const height = await conn.getBlockHeight({ commitment: "confirmed" });
      if (height > lastValidBlockHeight) {
        // blockhash expired -> requeue all still-pending for a fresh-blockhash retry
        for (const c of pending.values()) failed.push(c);
        break;
      }
      await sleep(1500);
    }
    for (const c of pending.values()) failed.push(c); // timeout leftovers -> retry
    return { confirmed, failed: [...new Set(failed)] };
  }

  // Single-tx send+confirm with fresh-blockhash retry rounds (resize / finalize / init).
  async function sendOne(tx: anchor.web3.Transaction, label: string): Promise<string> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const bh = await conn.getLatestBlockhash({ commitment: "confirmed" });
      let sig: string;
      try {
        sig = await sendRaw(tx, bh);
      } catch (e) {
        console.log(`    ${label} send err (attempt ${attempt}): ${(e as Error).message.slice(0, 80)}`);
        await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
        continue;
      }
      const res = await confirmBatch([{ chunk: 0, sig }], bh.lastValidBlockHeight);
      if (res.confirmed === 1) return sig;
      console.log(`    ${label} not confirmed (attempt ${attempt}); retrying`);
      await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
    }
    throw new Error(`${label} failed after ${MAX_RETRIES} attempts`);
  }
});
