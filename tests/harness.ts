/**
 * Shared test harness for the Secret Garden Protocol Stage 1 program.
 *
 * Tests run against `solana-bankrun`, an in-process Solana banks server (a local
 * validator). It is fully deterministic — no wall-clock waits, no network — and,
 * crucially, it lets us seed account state directly via `setAccount` / `setClock`.
 * That is the only honest way to exercise the `GamePaused` guard in Stage 1, which
 * deliberately ships no admin "set paused" instruction (only the three required
 * instructions exist). See `setPaused` below and the "while the game is paused" test.
 */
import { readFileSync } from "fs";
import * as anchor from "@anchor-lang/core";
import {
  startAnchor,
  ProgramTestContext,
  BanksClient,
  BanksTransactionResultWithMeta,
  Clock,
} from "solana-bankrun";
import type { SecretGarden } from "../target/types/secret_garden";

const { PublicKey, Transaction, SystemProgram } = anchor.web3;

const IDL = JSON.parse(
  readFileSync("./target/idl/secret_garden.json", "utf-8"),
) as anchor.Idl;

/** Anchor account discriminator (8 bytes) + GameConfig::authority (32 bytes). */
const PAUSED_OFFSET = 8 + 32;

/** A fixed timestamp used so `created_at` fields are deterministic across runs. */
export const FIXED_UNIX_TS = 1_700_000_000;

export interface SendResult {
  /** `null` on success, otherwise the runtime error string. */
  result: string | null;
  meta: BanksTransactionResultWithMeta["meta"];
}

export class Harness {
  readonly context: ProgramTestContext;
  readonly client: BanksClient;
  readonly program: anchor.Program<SecretGarden>;
  private slot = 1n;

  private constructor(
    context: ProgramTestContext,
    client: BanksClient,
    program: anchor.Program<SecretGarden>,
  ) {
    this.context = context;
    this.client = client;
    this.program = program;
  }

  static async create(): Promise<Harness> {
    const context = await startAnchor(".", [], []);
    const client = context.banksClient;

    // Minimal connection shim: Anchor's account decoder needs a Node `Buffer`,
    // while bankrun hands back a `Uint8Array`.
    const wrap = (acc: Awaited<ReturnType<BanksClient["getAccount"]>>) =>
      acc ? { ...acc, data: Buffer.from(acc.data) } : null;
    const connection = {
      async getAccountInfoAndContext(address: anchor.web3.PublicKey) {
        return {
          context: { slot: 0 },
          value: wrap(await client.getAccount(address)),
        };
      },
      async getAccountInfo(address: anchor.web3.PublicKey) {
        return wrap(await client.getAccount(address));
      },
    };
    const provider: anchor.Provider = {
      connection: connection as unknown as anchor.web3.Connection,
      publicKey: context.payer.publicKey,
    };
    const program = new anchor.Program<SecretGarden>(IDL, provider);
    return new Harness(context, client, program);
  }

  get payer(): anchor.web3.Keypair {
    return this.context.payer;
  }

  configPda(): anchor.web3.PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      this.program.programId,
    )[0];
  }

  profilePda(owner: anchor.web3.PublicKey): anchor.web3.PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("profile"), owner.toBuffer()],
      this.program.programId,
    )[0];
  }

  flowerPda(
    owner: anchor.web3.PublicKey,
    index: number,
  ): anchor.web3.PublicKey {
    const idx = Buffer.alloc(4);
    idx.writeUInt32LE(index);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("flower"), owner.toBuffer(), idx],
      this.program.programId,
    )[0];
  }

  roundPda(roundId: number | bigint): anchor.web3.PublicKey {
    const id = Buffer.alloc(8);
    id.writeBigUInt64LE(BigInt(roundId));
    return PublicKey.findProgramAddressSync(
      [Buffer.from("round"), id],
      this.program.programId,
    )[0];
  }

  entryPda(
    round: anchor.web3.PublicKey,
    player: anchor.web3.PublicKey,
  ): anchor.web3.PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("entry"), round.toBuffer(), player.toBuffer()],
      this.program.programId,
    )[0];
  }

  /** All six starter flower PDAs for an owner, indexed 0..=5. */
  flowerPdas(owner: anchor.web3.PublicKey): anchor.web3.PublicKey[] {
    return Array.from({ length: 6 }, (_, i) => this.flowerPda(owner, i));
  }

  systemProgram(): anchor.web3.PublicKey {
    return SystemProgram.programId;
  }

  /** Pin the on-chain clock to a fixed unix timestamp (keeps `created_at` stable). */
  async setFixedClock(unixTimestamp: number = FIXED_UNIX_TS): Promise<void> {
    const c = await this.client.getClock();
    this.context.setClock(
      new Clock(
        c.slot,
        c.epochStartTimestamp,
        c.epoch,
        c.leaderScheduleEpoch,
        BigInt(unixTimestamp),
      ),
    );
  }

  /** Create a fresh keypair pre-funded with SOL so it can pay for transactions. */
  fundedKeypair(sol = 10): anchor.web3.Keypair {
    const kp = anchor.web3.Keypair.generate();
    this.context.setAccount(kp.publicKey, {
      lamports: sol * anchor.web3.LAMPORTS_PER_SOL,
      data: Buffer.alloc(0),
      owner: SystemProgram.programId,
      executable: false,
      rentEpoch: 0,
    });
    return kp;
  }

  /** Force the `GameConfig.paused` flag without an on-chain instruction. */
  async setPaused(paused: boolean): Promise<void> {
    const pda = this.configPda();
    const acc = await this.client.getAccount(pda);
    if (!acc) throw new Error("config account not initialized");
    const data = Buffer.from(acc.data);
    data[PAUSED_OFFSET] = paused ? 1 : 0;
    this.context.setAccount(pda, { ...acc, data });
  }

  /**
   * Sign and process a transaction. Each call advances the slot so every
   * transaction gets a unique recent blockhash — otherwise an identical retry
   * would be rejected as "already processed" before the program ever runs, which
   * would mask the real success/failure we want to assert.
   *
   * The clock is pinned to `unixTimestamp` (default `FIXED_UNIX_TS`) so timestamps
   * are deterministic; pass a later value to test time-dependent paths (deadlines).
   */
  async send(
    instructions: anchor.web3.TransactionInstruction[],
    signers: anchor.web3.Keypair[],
    unixTimestamp: number = FIXED_UNIX_TS,
  ): Promise<SendResult> {
    this.slot += 1n;
    this.context.warpToSlot(this.slot);
    // Pin the clock after warping so timestamps are deterministic.
    await this.setFixedClock(unixTimestamp);
    const tx = new Transaction();
    tx.recentBlockhash = this.context.lastBlockhash;
    tx.feePayer = signers[0].publicKey;
    tx.add(...instructions);
    tx.sign(...signers);
    const res = await this.client.tryProcessTransaction(tx);
    return { result: res.result, meta: res.meta };
  }
}
