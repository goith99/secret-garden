/**
 * Secret Garden Protocol — Private Hint tests (bankrun).
 *
 * `queue_private_hint` is an Arcium QUEUE instruction, so — exactly like `start_breeding`
 * and `queue_score_entry` — its body and its explicit `constraint =` checks cannot be
 * exercised under bankrun. Anchor deserializes EVERY account (running each account's
 * built-in owner/deser checks) before it evaluates any explicit `constraint`, and the
 * Arcium cluster accounts (mxe, mempool, cluster, comp-def, …) do not exist in bankrun, so
 * deserialization aborts with `AccountNotInitialized` (0xbc4) before the round-open /
 * flower-ownership / not-locked guards are reached. This is the same limitation documented
 * in `hardening.ts` for the other two queue instructions; those game guards (and the full
 * seal → callback → client-decrypt round-trip) are a live-cluster concern, verified there.
 *
 * What bankrun DOES verify here, and what these tests cover:
 *   - the `HintResult` account layout round-trips through encode/decode (the IDL and the
 *     on-chain layout agree — the migration-critical property);
 *   - `queue_private_hint` is registered and its account context resolves the game-side
 *     PDAs (player / round / flower / hint_result), reaching on-chain account resolution.
 */
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { assert, expect } from "chai";
import { Harness, FIXED_UNIX_TS } from "./harness.ts";
import { openRoundAccounts, seedSgd, ixSetSgdMint } from "./sgd.ts";

const { PublicKey, Keypair } = anchor.web3;
type PK = anchor.web3.PublicKey;

// Anchor framework error: the program expected an account to be already initialized. The
// missing Arcium cluster accounts hit this during deserialization, before any game guard.
const ERR_ACCOUNT_NOT_INITIALIZED = "0xbc4"; // 3012

function hintPda(h: Harness, player: PK): PK {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("hint"), player.toBuffer()],
    h.program.programId,
  )[0];
}

// --- instruction builders ----------------------------------------------------

const ixInitConfig = (h: Harness, authority: PK) =>
  h.program.methods
    .initializeConfig()
    .accountsStrict({ authority, config: h.configPda(), systemProgram: h.systemProgram() })
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

const ixOpenRound = (h: Harness, authority: PK, currentRound: number) =>
  h.program.methods
    .openRound()
    .accountsStrict({
      authority,
      config: h.configPda(),
      previousRound: currentRound > 0 ? h.roundPda(currentRound) : null,
      round: h.roundPda(currentRound + 1),
      systemProgram: h.systemProgram(),
      ...openRoundAccounts(h, currentRound + 1),
    })
    .instruction();

/** Build `queue_private_hint`. Arcium queue accounts are dummy pubkeys (they don't exist
 *  under bankrun; the tx fails at their deserialization). Game accounts are real PDAs. */
const ixQueueHint = (h: Harness, player: PK, roundId: number, flowerIndex: number) => {
  const dummy = () => Keypair.generate().publicKey;
  return h.program.methods
    .queuePrivateHint(new BN(1234), Array(32).fill(7), new BN(0))
    .accountsStrict({
      player,
      round: h.roundPda(roundId),
      flower: h.flowerPda(player, flowerIndex),
      hintResult: hintPda(h, player),
      signPdaAccount: dummy(),
      mxeAccount: dummy(),
      mempoolAccount: dummy(),
      executingPool: dummy(),
      computationAccount: dummy(),
      compDefAccount: dummy(),
      clusterAccount: dummy(),
      poolAccount: dummy(),
      clockAccount: dummy(),
      systemProgram: h.systemProgram(),
      arciumProgram: dummy(),
    })
    .instruction();
};

async function bootstrapWithOpenRound(): Promise<{ h: Harness; authority: anchor.web3.Keypair }> {
  const h = await Harness.create();
  const authority = h.payer;
  await h.send([await ixInitConfig(h, authority.publicKey)], [authority]);
  // $SGD: open_round now creates the round's pot vault, so the mint must be pinned and the
  // vault materialised before a round can be opened at all.
  seedSgd(h, [authority.publicKey]);
  await h.send([await ixSetSgdMint(h, authority.publicKey)], [authority]);
  await h.send([await ixCreateProfile(h, authority.publicKey)], [authority]);
  await h.send([await ixClaimStarters(h, authority.publicKey)], [authority]);
  const r = await h.send([await ixOpenRound(h, authority.publicKey, 0)], [authority]);
  assert.isNull(r.result, `open_round (setup) failed: ${r.result}`);
  return { h, authority };
}

describe("Private Hint (bankrun)", () => {
  describe("queue_private_hint — wiring / account resolution", () => {
    it("is registered and resolves its game accounts, then reaches Arcium account resolution", async () => {
      // With a valid open round + owned Active starter flower, the tx passes client-side
      // account resolution and on-chain reaches the (absent) Arcium accounts, failing with
      // AccountNotInitialized. This proves the instruction + its account context are wired;
      // the round-open / ownership / not-locked guards and the sealed round-trip are
      // verified against a live cluster (see the module header).
      const { h, authority } = await bootstrapWithOpenRound();
      const r = await h.send([await ixQueueHint(h, authority.publicKey, 1, 0)], [authority]);
      assert.isNotNull(r.result, "queue_private_hint should not fully succeed under bankrun");
      expect(r.result).to.include(ERR_ACCOUNT_NOT_INITIALIZED);
    });
  });

  describe("HintResult account layout (round-trip)", () => {
    it("encodes and decodes with the expected fields", async () => {
      const h = await Harness.create();
      const player = h.fundedKeypair();
      const pda = hintPda(h, player.publicKey);

      const encKey = Array.from({ length: 32 }, (_, i) => i + 1);
      const nonce = Array.from({ length: 16 }, (_, i) => 100 + i);
      const ct = Array.from({ length: 32 }, (_, i) => 200 - i);

      const data = await h.program.coder.accounts.encode("hintResult", {
        player: player.publicKey,
        roundId: new BN(9),
        targetTraitCount: 3,
        ready: true,
        encryptionKey: encKey,
        nonce,
        ciphertext: ct,
        computedAt: new BN(FIXED_UNIX_TS),
        bump: 254,
      });
      h.context.setAccount(pda, {
        lamports: 5_000_000,
        data: Buffer.from(data),
        owner: h.program.programId,
        executable: false,
        rentEpoch: 0,
      });

      const hint = await h.program.account.hintResult.fetch(pda);
      expect(hint.player.toBase58()).to.equal(player.publicKey.toBase58());
      expect(hint.roundId.toNumber()).to.equal(9);
      expect(hint.targetTraitCount).to.equal(3);
      expect(hint.ready).to.equal(true);
      expect(Array.from(hint.encryptionKey)).to.deep.equal(encKey);
      expect(Array.from(hint.nonce)).to.deep.equal(nonce);
      expect(Array.from(hint.ciphertext)).to.deep.equal(ct);
      expect(hint.computedAt.toNumber()).to.equal(FIXED_UNIX_TS);
      expect(hint.bump).to.equal(254);
    });
  });
});
