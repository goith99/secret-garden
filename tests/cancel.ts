/**
 * Secret Garden Protocol — Stage 3B: cancel_expired_experiment (bankrun).
 *
 * The timeout logic needs deterministic clock control, which the live Arcium validator
 * cannot provide but bankrun can (`setClock`). Since `start_breeding` requires Arcium
 * accounts that do not exist under bankrun, the test crafts a Queued `Experiment` (and
 * the matching Locked parents) directly with `setAccount`, then drives the clock across
 * the timeout boundary.
 */
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { assert, expect } from "chai";
import { Harness, FIXED_UNIX_TS } from "./harness.ts";

const { PublicKey } = anchor.web3;

// Anchor custom error codes (6000 + variant index); see programs/.../error.rs.
const ERR_NOT_YET_EXPIRED = "0x177f"; // 6015 ExperimentNotYetExpired
const ERR_ALREADY_RESOLVED = "0x1780"; // 6016 ExperimentAlreadyResolved

// Mirror of on-chain constants.
const FLOWER_STATUS_ACTIVE = 0;
const FLOWER_STATUS_LOCKED = 1;
const EXPERIMENT_STATUS_QUEUED = 0;
const EXPERIMENT_STATUS_EXPIRED = 4;
const EXPERIMENT_TIMEOUT_SECONDS = 600;

// Borsh-packed offsets (account discriminator = 8).
const FLOWER_STATUS_OFFSET = 8 + 32 + 4 + 1 + 2 + 1 + 1 + 4 + 32 + 32 + 1 + 32; // = 150
// PlayerProfile.active_experiment_count: after owner(32) starter_claimed(1)
// total_flowers(2) total_crosses(2) daily_attempts(1) final_submissions(1) created_at(8).
const PROFILE_ACTIVE_EXP_OFFSET = 8 + 32 + 1 + 2 + 2 + 1 + 1 + 8; // = 55

type PK = anchor.web3.PublicKey;

const ixInitConfig = (h: Harness, authority: PK) =>
  h.program.methods
    .initializeConfig()
    .accountsStrict({
      authority,
      config: h.configPda(),
      systemProgram: h.systemProgram(),
    })
    .instruction();

const ixCreateProfile = (h: Harness, owner: PK) =>
  h.program.methods
    .createProfile()
    .accountsStrict({
      owner,
      config: h.configPda(),
      profile: h.profilePda(owner),
      systemProgram: h.systemProgram(),
    })
    .instruction();

const ixClaimStarters = (h: Harness, owner: PK) => {
  const f = h.flowerPdas(owner);
  return h.program.methods
    .claimStarters()
    .accountsStrict({
      owner,
      config: h.configPda(),
      profile: h.profilePda(owner),
      flower0: f[0],
      flower1: f[1],
      flower2: f[2],
      flower3: f[3],
      flower4: f[4],
      flower5: f[5],
      systemProgram: h.systemProgram(),
    })
    .instruction();
};

function experimentPda(h: Harness, owner: PK, index: number): PK {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(index);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("experiment"), owner.toBuffer(), b],
    h.program.programId,
  )[0];
}

async function patch(
  h: Harness,
  pda: PK,
  mutate: (d: Buffer) => void,
): Promise<void> {
  const acc = await h.client.getAccount(pda);
  assert.isNotNull(acc);
  const data = Buffer.from(acc!.data);
  mutate(data);
  h.context.setAccount(pda, { ...acc!, data });
}

describe("secret-garden Stage 3B: cancel_expired_experiment", () => {
  let h: Harness;
  let player: anchor.web3.Keypair;
  let expPda: PK;
  let parentA: PK;
  let parentB: PK;

  before(async () => {
    h = await Harness.create();
    player = h.payer;
    await h.send([await ixInitConfig(h, player.publicKey)], [player]);
    await h.send([await ixCreateProfile(h, player.publicKey)], [player]);
    await h.send([await ixClaimStarters(h, player.publicKey)], [player]);

    parentA = h.flowerPda(player.publicKey, 0);
    parentB = h.flowerPda(player.publicKey, 1);
    expPda = experimentPda(h, player.publicKey, 0);

    // Craft a Queued experiment created at FIXED_UNIX_TS with the two starters as parents.
    const data = await h.program.coder.accounts.encode("experiment", {
      owner: player.publicKey,
      parentA,
      parentB,
      computationOffset: new BN(424242),
      status: EXPERIMENT_STATUS_QUEUED,
      resultFlower: PublicKey.default,
      createdAt: new BN(FIXED_UNIX_TS),
      updatedAt: new BN(FIXED_UNIX_TS),
      errorCode: 0,
      callbackProcessed: false,
      bump: 255,
    });
    h.context.setAccount(expPda, {
      lamports: 5_000_000,
      data,
      owner: h.program.programId,
      executable: false,
      rentEpoch: 0,
    });

    // Lock both parents and mark one active experiment (as start_breeding would have).
    await patch(
      h,
      parentA,
      (d) => (d[FLOWER_STATUS_OFFSET] = FLOWER_STATUS_LOCKED),
    );
    await patch(
      h,
      parentB,
      (d) => (d[FLOWER_STATUS_OFFSET] = FLOWER_STATUS_LOCKED),
    );
    await patch(h, h.profilePda(player.publicKey), (d) =>
      d.writeUInt32LE(1, PROFILE_ACTIVE_EXP_OFFSET),
    );
  });

  const cancelIx = async (caller: PK) =>
    h.program.methods
      .cancelExpiredExperiment()
      .accountsStrict({
        caller,
        experiment: expPda,
        profile: h.profilePda(player.publicKey),
        flowerA: parentA,
        flowerB: parentB,
      })
      .instruction();

  it("fails before the timeout has elapsed", async () => {
    const caller = h.fundedKeypair();
    const r = await h.send(
      [await cancelIx(caller.publicKey)],
      [caller],
      FIXED_UNIX_TS + 100,
    );
    assert.isNotNull(r.result, "cancel before timeout should fail");
    expect(r.result).to.contain(ERR_NOT_YET_EXPIRED);
  });

  it("succeeds once the timeout has elapsed (permissionless caller unlocks parents)", async () => {
    const caller = h.fundedKeypair();
    const at = FIXED_UNIX_TS + EXPERIMENT_TIMEOUT_SECONDS;
    const r = await h.send([await cancelIx(caller.publicKey)], [caller], at);
    assert.isNull(r.result, `cancel after timeout failed: ${r.result}`);

    const exp = await h.program.account.experiment.fetch(expPda);
    expect(exp.status).to.equal(EXPERIMENT_STATUS_EXPIRED);
    expect(exp.callbackProcessed).to.equal(true); // so a late callback no-ops

    expect(
      (await h.program.account.flowerRecord.fetch(parentA)).status,
    ).to.equal(FLOWER_STATUS_ACTIVE);
    expect(
      (await h.program.account.flowerRecord.fetch(parentB)).status,
    ).to.equal(FLOWER_STATUS_ACTIVE);
    expect(
      (
        await h.program.account.playerProfile.fetch(
          h.profilePda(player.publicKey),
        )
      ).activeExperimentCount,
    ).to.equal(0);
  });

  it("fails if called again on an already-resolved experiment", async () => {
    const caller = h.fundedKeypair();
    const at = FIXED_UNIX_TS + EXPERIMENT_TIMEOUT_SECONDS + 50;
    const r = await h.send([await cancelIx(caller.publicKey)], [caller], at);
    assert.isNotNull(r.result, "second cancel should fail");
    expect(r.result).to.contain(ERR_ALREADY_RESOLVED);
  });
});
