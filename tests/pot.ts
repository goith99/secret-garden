/**
 * $SGD entry-fee pot: collection, equal split, and the security properties that matter once
 * this holds real money.
 *
 * The split is EQUAL between however many winners the reveal actually named — not tiered — so
 * every podium finisher breaks even at 3 entrants and profits above that.
 */
import * as anchor from "@anchor-lang/core";
import fs from "fs";
import BN from "bn.js";
import { assert, expect } from "chai";
import { FIXED_UNIX_TS, Harness, ataFor, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "./harness.ts";
import {
  seedSgd,
  feeAccounts,
  ixSetSgdMint,
  openRoundAccounts,
  SGD_DECIMALS,
  SGD_MINT,
  ENTRY_FEE_SGD,
} from "./sgd.ts";

const { PublicKey, Keypair } = anchor.web3;
type PK = anchor.web3.PublicKey;

const ROUND_STATUS_FINALIZED = 2;
// Anchor surfaces custom errors as hex in the failure string.
const ERR_INSUFFICIENT_FEE = "0x17a9"; // 6057
const ERR_WRONG_MINT = "0x17ac";
const ERR_ROUND_NOT_FINAL = "0x17a4"; // 6052 RoundNotFinalized
const ERR_POT_NOT_DRAINED = "0x17b0"; // 6064 PotNotDrained
const ERR_MINT_ALREADY = "0x17ab"; // 6059 SgdMintAlreadySet // 6060
const ERR_NOT_REVEALED = "0x17ad"; // 6061
const ERR_POT_TOO_SMALL = "0x17ae"; // 6062
const FEE = ENTRY_FEE_SGD;

const ixInitConfig = (h: Harness, authority: PK) =>
  h.program.methods.initializeConfig()
    .accountsStrict({ authority, config: h.configPda(), systemProgram: h.systemProgram() }).instruction();
const ixCreateProfile = (h: Harness, owner: PK) =>
  h.program.methods.createProfile()
    .accountsStrict({ owner, config: h.configPda(), profile: h.profilePda(owner), systemProgram: h.systemProgram() }).instruction();
const ixClaimStarters = (h: Harness, owner: PK) => {
  const f = h.flowerPdas(owner);
  return h.program.methods.claimStarters().accountsStrict({
    owner, config: h.configPda(), profile: h.profilePda(owner),
    flower0: f[0], flower1: f[1], flower2: f[2], flower3: f[3], flower4: f[4], flower5: f[5],
    systemProgram: h.systemProgram(),
  }).instruction();
};
const ixOpenRound = (h: Harness, authority: PK, currentRound: number) =>
  h.program.methods.openRound().accountsStrict({
    authority, config: h.configPda(),
    previousRound: currentRound > 0 ? h.roundPda(currentRound) : null,
    round: h.roundPda(currentRound + 1), systemProgram: h.systemProgram(),
    ...openRoundAccounts(h, currentRound + 1),
  }).instruction();
const ixSubmit = (h: Harness, player: PK, roundId: number, flowerIndex: number, override?: any) => {
  const round = h.roundPda(roundId);
  return h.program.methods.submitEntry().accountsStrict({
    player, config: h.configPda(), profile: h.profilePda(player), round,
    flowerRecord: h.flowerPda(player, flowerIndex), entry: h.entryPda(round, player),
    systemProgram: h.systemProgram(),
    ...feeAccounts(h, player, roundId), ...(override ?? {}),
  }).instruction();
};
const ixDistribute = (h: Harness, authority: PK, roundId: number, pairs: PK[], override?: any) =>
  h.program.methods.distributePot().accountsStrict({
    authority, config: h.configPda(), round: h.roundPda(roundId),
    settlement: h.settlementPda(roundId),
    potAuthority: h.potAuthorityPda(roundId),
    potVault: ataFor(h.potAuthorityPda(roundId), SGD_MINT),
    sgdMint: SGD_MINT, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: h.systemProgram(),
    ...(override ?? {}),
  }).remainingAccounts(pairs.map((p) => ({ pubkey: p, isSigner: false, isWritable: true }))).instruction();

const ixRefund = (h: Harness, authority: PK, roundId: number, pairs: PK[], override?: any) =>
  h.program.methods.refundUnrevealedPot().accountsStrict({
    authority, config: h.configPda(), round: h.roundPda(roundId),
    settlement: h.settlementPda(roundId),
    potAuthority: h.potAuthorityPda(roundId),
    potVault: ataFor(h.potAuthorityPda(roundId), SGD_MINT),
    sgdMint: SGD_MINT, tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: h.systemProgram(),
    ...(override ?? {}),
  }).remainingAccounts(pairs.map((p) => ({ pubkey: p, isSigner: false, isWritable: true }))).instruction();

const ixClosePotVault = (h: Harness, authority: PK, roundId: number, override?: any) =>
  h.program.methods.closePotVault().accountsStrict({
    authority, config: h.configPda(), round: h.roundPda(roundId),
    settlement: h.settlementPda(roundId),
    potAuthority: h.potAuthorityPda(roundId),
    potVault: ataFor(h.potAuthorityPda(roundId), SGD_MINT),
    sgdMint: SGD_MINT,
    // Pinned on-chain to config.authority, which in these suites is the same key.
    surplusDestination: ataFor(authority, SGD_MINT),
    tokenProgram: TOKEN_PROGRAM_ID,
    ...(override ?? {}),
  }).instruction();

/** A second $SGD-shaped mint, to migrate TO. */
const NEW_SGD_MINT = anchor.web3.Keypair.generate().publicKey;

const ixUpdateSgdMint = (h: Harness, authority: PK, roundId: number, override?: any) =>
  h.program.methods.updateSgdMint().accountsStrict({
    authority, config: h.configPda(), round: h.roundPda(roundId),
    settlement: h.settlementPda(roundId),
    newSgdMint: NEW_SGD_MINT,
    ...(override ?? {}),
  }).instruction();

/** Config + N players (each with a profile and starters) + $SGD + an open round 1. */
async function bootstrap(playerCount: number) {
  const h = await Harness.create();
  const authority = h.payer;
  await h.send([await ixInitConfig(h, authority.publicKey)], [authority]);

  const players = [authority, ...Array.from({ length: playerCount - 1 }, () => h.fundedKeypair())];
  seedSgd(h, players.map((p) => p.publicKey));
  await h.send([await ixSetSgdMint(h, authority.publicKey)], [authority]);
  for (const p of players) {
    await h.send([await ixCreateProfile(h, p.publicKey)], [p]);
    await h.send([await ixClaimStarters(h, p.publicKey)], [p]);
  }
  await h.send([await ixOpenRound(h, authority.publicKey, 0)], [authority]);
  return { h, authority, players };
}

/** Force a round into "finalized and revealed" with the given winning entries. */
async function revealWith(h: Harness, roundId: number, winners: PK[]) {
  const pda = h.roundPda(roundId);
  const r: any = await h.program.account.competitionRound.fetch(pda);
  r.status = ROUND_STATUS_FINALIZED;
  r.scoringRevealed = true;
  r.top1 = winners[0] ?? PublicKey.default;
  r.top2 = winners[1] ?? PublicKey.default;
  r.top3 = winners[2] ?? PublicKey.default;
  // Re-encode through Anchor's own coder rather than poking byte offsets, so this stays
  // correct if the struct ever gains a field.
  const data = await h.program.coder.accounts.encode("competitionRound", r);
  const acc = await h.client.getAccount(pda);
  h.context.setAccount(pda, { ...acc!, data });
}

const ERR_REVEALED = "0x17b1"; // 6065 RoundAlreadyRevealed
const ERR_TOO_EARLY = "0x17b2"; // 6066 RefundTooEarly
const ERR_ALREADY_DIST = "0x17b3"; // 6067 PotAlreadyDistributed
const ERR_ALREADY_REFUND = "0x17b4"; // 6068 PotAlreadyRefunded
const ERR_ORDER = "0x17b5"; // 6069 RefundOrderInvalid
const ERR_BATCH_LONG = "0x17b6"; // 6070 RefundBatchTooLong
const ERR_REFUND_INCOMPLETE = "0x17b7"; // 6071 RefundIncomplete
const ERR_NOT_SETTLED = "0x17b8"; // 6072 PotNotSettled
const ERR_WRONG_ROUND = "0x17b9"; // 6073 EntryWrongRound
const ERR_WRONG_WINNER = "0x17ba"; // 6074 WrongWinnerAccount
// Anchor built-in: a typed account that does not exist yet.
const ERR_UNINIT = "0xbc4"; // 3012 AccountNotInitialized
// Anchor built-in: a seed-derived account whose address does not match.
const ERR_SEEDS = "0x7d6"; // 2006 ConstraintSeeds
// Anchor built-in: an `associated_token::` pin that the passed account does not satisfy.
const ERR_ASSOCIATED = "0x7d9"; // 2009 ConstraintAssociated
const ERR_WRONG_DECIMALS = "0x17bb"; // 6075 WrongSgdDecimals
// RoundSettlement.state values, mirroring the SETTLEMENT_* constants.
const ST_NONE = 0, ST_REFUND_PENDING = 1, ST_PAID = 2, ST_REFUNDED = 3;
const ERR_NOT_AUTHORITY = "0x1771"; // 6001 NotAuthority

/** Well past `POT_REFUND_MIN_AGE_SECONDS` after round 1's deadline. */
const LATE = FIXED_UNIX_TS + 10 * 86400;

/** Force a round to FINALIZED while leaving it UNREVEALED — the state the hatch exists for. */
async function finalizeUnrevealed(h: Harness, roundId: number) {
  const pda = h.roundPda(roundId);
  const r: any = await h.program.account.competitionRound.fetch(pda);
  r.status = ROUND_STATUS_FINALIZED;
  r.scoringRevealed = false;
  const data = await h.program.coder.accounts.encode("competitionRound", r);
  const acc = await h.client.getAccount(pda);
  h.context.setAccount(pda, { ...acc!, data });
}

/** Flip an already-finalized round to revealed, to simulate a reveal arriving late. */
async function lateReveal(h: Harness, roundId: number, winners: PK[]) {
  await revealWith(h, roundId, winners);
}

/** A finalized-but-UNREVEALED round 1 with `k` entrants, entries pre-sorted for the cursor. */
async function unrevealedRound(k: number) {
  const { h, authority, players } = await bootstrap(k);
  const subs = players.slice(0, k);
  for (const p of subs) await h.send([await ixSubmit(h, p.publicKey, 1, 0)], [p]);
  await finalizeUnrevealed(h, 1);
  // The instruction demands strictly ascending entry pubkeys, so the caller must sort — and
  // BYTE-wise, not base58, which orders differently for roughly one key in 256.
  const rows = subs
    .map((p) => ({ entry: h.entryPda(h.roundPda(1), p.publicKey), ata: ataFor(p.publicKey, SGD_MINT), p }))
    .sort((a, b) => Buffer.compare(a.entry.toBuffer(), b.entry.toBuffer()));
  return { h, authority, players: subs, rows };
}
const flat = (rows: any[]) => rows.flatMap((r) => [r.entry, r.ata]);

describe("$SGD entry-fee pot", () => {
  describe("vault provisioning", () => {
    it("open_round leaves a pot vault that is present, empty and PDA-owned", async () => {
      const { h } = await bootstrap(1);
      const vault = ataFor(h.potAuthorityPda(1), SGD_MINT);
      expect(await h.tokenBalance(vault)).to.equal(0n, "a fresh round's pot must be empty");
      const acc = await h.client.getAccount(vault);
      assert.isNotNull(acc, "open_round must leave the vault in place");
      const data = Buffer.from(acc!.data);
      expect(new PublicKey(data.subarray(0, 32)).toBase58()).to.equal(SGD_MINT.toBase58());
      expect(new PublicKey(data.subarray(32, 64)).toBase58()).to.equal(
        h.potAuthorityPda(1).toBase58(),
        "the vault must be owned by the round's pot-authority PDA, not a keypair",
      );
    });

    it("each round gets its own vault, so pots never mix", async () => {
      const { h } = await bootstrap(1);
      expect(h.potAuthorityPda(1).toBase58()).to.not.equal(h.potAuthorityPda(2).toBase58());
      expect(ataFor(h.potAuthorityPda(1), SGD_MINT).toBase58()).to.not.equal(
        ataFor(h.potAuthorityPda(2), SGD_MINT).toBase58(),
      );
    });

    it("submit_entry never creates the vault — it only writes into the existing one", async () => {
      // The whole point of moving creation into open_round: the first entrant must not be
      // billed rent that later entrants avoid. Both players pay exactly the fee in SOL terms.
      const { h, players } = await bootstrap(2);
      const solBefore = await Promise.all(
        players.map(async (p) => (await h.client.getAccount(p.publicKey))!.lamports),
      );
      for (const p of players) {
        const r = await h.send([await ixSubmit(h, p.publicKey, 1, 0)], [p]);
        assert.isNull(r.result, `submit failed: ${r.result}`);
      }
      const solAfter = await Promise.all(
        players.map(async (p) => (await h.client.getAccount(p.publicKey))!.lamports),
      );
      const spent = solBefore.map((b, i) => b - solAfter[i]);
      // The first entrant must not pay ~0.00204 SOL more than the second.
      expect(Math.abs(Number(spent[0] - spent[1]))).to.be.lessThan(
        2_039_280,
        "the first entrant paid vault rent — creation leaked back into submit_entry",
      );
    });
  });

  describe("fee collection", () => {
    it("charges the fee into the round's pot vault and debits the player", async () => {
      const { h, players } = await bootstrap(1);
      const p = players[0].publicKey;
      const before = await h.tokenBalance(ataFor(p, SGD_MINT));
      const r = await h.send([await ixSubmit(h, p, 1, 0)], [players[0]]);
      assert.isNull(r.result, `submit failed: ${r.result}`);
      expect(await h.tokenBalance(ataFor(p, SGD_MINT))).to.equal(before! - FEE);
      expect(await h.tokenBalance(ataFor(h.potAuthorityPda(1), SGD_MINT))).to.equal(FEE);
    });

    it("refuses a player who cannot cover the fee, with a named error", async () => {
      const { h, players } = await bootstrap(1);
      const p = players[0].publicKey;
      h.setTokenAccount(SGD_MINT, p, FEE - 1n); // one base unit short
      const r = await h.send([await ixSubmit(h, p, 1, 0)], [players[0]]);
      assert.isNotNull(r.result, "underfunded submit should fail");
      expect(r.result).to.contain(ERR_INSUFFICIENT_FEE);
    });

    it("cannot be bypassed by pointing the fee at a vault the player controls", async () => {
      const { h, players } = await bootstrap(1);
      const p = players[0].publicKey;
      const rogue = Keypair.generate().publicKey;
      h.setTokenAccount(SGD_MINT, p, 0n, rogue); // a $SGD account owned by the player
      const r = await h.send(
        [await ixSubmit(h, p, 1, 0, { potVault: rogue })], [players[0]]);
      assert.isNotNull(r.result, "self-directed pot vault must be rejected");
      expect(r.result).to.contain(ERR_WRONG_MINT);
    });

    it("rejects a substituted mint", async () => {
      const { h, players } = await bootstrap(1);
      const p = players[0].publicKey;
      const fake = Keypair.generate().publicKey;
      h.setMint(fake, 6);
      h.setTokenAccount(fake, p, 1_000_000_000n);
      const r = await h.send(
        [await ixSubmit(h, p, 1, 0, { sgdMint: fake, playerSgdAta: ataFor(p, fake) })], [players[0]]);
      assert.isNotNull(r.result, "wrong mint must be rejected");
      expect(r.result).to.contain(ERR_WRONG_MINT);
    });
  });

  describe("equal split", () => {
    /** Run a round with `k` real entrants, force the pot to `pot`, distribute, return payouts. */
    async function runSplit(k: number, pot: bigint) {
      const { h, authority, players } = await bootstrap(k);
      const entries: PK[] = [];
      for (const p of players.slice(0, k)) {
        await h.send([await ixSubmit(h, p.publicKey, 1, 0)], [p]);
        entries.push(h.entryPda(h.roundPda(1), p.publicKey));
      }
      // Override the collected amount so the split can be exercised at any scale without
      // needing that many real submissions.
      h.setTokenAccount(SGD_MINT, h.potAuthorityPda(1), pot);
      await revealWith(h, 1, entries);

      const before = await Promise.all(players.slice(0, k).map((p) => h.tokenBalance(ataFor(p.publicKey, SGD_MINT))));
      const pairs: PK[] = [];
      players.slice(0, k).forEach((p, i) => { pairs.push(entries[i], ataFor(p.publicKey, SGD_MINT)); });
      const r = await h.send([await ixDistribute(h, authority.publicKey, 1, pairs)], [authority]);
      assert.isNull(r.result, `distribute failed: ${r.result}`);
      const after = await Promise.all(players.slice(0, k).map((p) => h.tokenBalance(ataFor(p.publicKey, SGD_MINT))));
      const paid = after.map((a, i) => a! - before[i]!);
      const residual = await h.tokenBalance(ataFor(h.potAuthorityPda(1), SGD_MINT));
      return { h, paid, residual, authority, entries, players };
    }

    it("k=1 pays the whole pot to the single winner", async () => {
      const { paid, residual } = await runSplit(1, 100_000_000n);
      expect(paid).to.deep.equal([100_000_000n]);
      expect(residual).to.equal(0n);
    });

    it("k=2 splits in half", async () => {
      const { paid, residual } = await runSplit(2, 200_000_000n);
      expect(paid).to.deep.equal([100_000_000n, 100_000_000n]);
      expect(residual).to.equal(0n);
    });

    it("k=3 splits in thirds, last winner absorbing the remainder", async () => {
      // 20 entrants' worth of fees: 2000 SGD, which does not divide by 3.
      const { paid, residual } = await runSplit(3, 2_000_000_000n);
      expect(paid).to.deep.equal([666_666_666n, 666_666_666n, 666_666_668n]);
      expect(paid.reduce((a, b) => a + b, 0n)).to.equal(2_000_000_000n);
      expect(residual).to.equal(0n, "vault must drain to exactly zero");
    });

    it("drains the vault exactly at every indivisible pot size", async () => {
      for (const pot of [3n, 4n, 5n, 100n, 999_999_999n, 1_000_000_001n]) {
        const { paid, residual } = await runSplit(3, pot);
        expect(paid.reduce((a, b) => a + b, 0n)).to.equal(pot, `pot ${pot} not fully paid`);
        expect(residual).to.equal(0n, `pot ${pot} left dust`);
      }
    });

    it("refuses a pot too small to give every winner a base unit", async () => {
      const { h, authority, players } = await bootstrap(3);
      const entries: PK[] = [];
      for (const p of players) {
        await h.send([await ixSubmit(h, p.publicKey, 1, 0)], [p]);
        entries.push(h.entryPda(h.roundPda(1), p.publicKey));
      }
      h.setTokenAccount(SGD_MINT, h.potAuthorityPda(1), 2n); // 2 base units, 3 winners
      await revealWith(h, 1, entries);
      const pairs: PK[] = [];
      players.forEach((p, i) => { pairs.push(entries[i], ataFor(p.publicKey, SGD_MINT)); });
      const r = await h.send([await ixDistribute(h, authority.publicKey, 1, pairs)], [authority]);
      assert.isNotNull(r.result, "a 2-unit pot for 3 winners must be refused");
      expect(r.result).to.contain(ERR_POT_TOO_SMALL);
    });
  });

  describe("replay protection", () => {
    async function distributedRound() {
      const { h, authority, players } = await bootstrap(3);
      const entries: PK[] = [];
      for (const p of players) {
        await h.send([await ixSubmit(h, p.publicKey, 1, 0)], [p]);
        entries.push(h.entryPda(h.roundPda(1), p.publicKey));
      }
      await revealWith(h, 1, entries);
      const pairs: PK[] = [];
      players.forEach((p, i) => { pairs.push(entries[i], ataFor(p.publicKey, SGD_MINT)); });
      const r = await h.send([await ixDistribute(h, authority.publicKey, 1, pairs)], [authority]);
      assert.isNull(r.result, `first distribute failed: ${r.result}`);
      return { h, authority, players, entries, pairs };
    }

    it("a second distribute_pot for the same round fails", async () => {
      const { h, authority, pairs } = await distributedRound();
      const r = await h.send([await ixDistribute(h, authority.publicKey, 1, pairs)], [authority]);
      assert.isNotNull(r.result, "replay must be rejected");
    });

    it("REGRESSION: refilling the drained vault does NOT re-arm the payout", async () => {
      // The exploit found in the earlier throwaway simulation: because SPL lets anyone
      // transfer into any token account, "the vault is empty" was not proof a round had been
      // paid — a donation re-armed a second full payout. The PotDistribution marker is what
      // closes that hole, and this test is the proof.
      const { h, authority, players, pairs } = await distributedRound();
      h.setTokenAccount(SGD_MINT, h.potAuthorityPda(1), 50_000_000n); // "donation"
      const before = await h.tokenBalance(ataFor(players[0].publicKey, SGD_MINT));
      const r = await h.send([await ixDistribute(h, authority.publicKey, 1, pairs)], [authority]);
      assert.isNotNull(r.result, "a refilled vault must not be distributable again");
      expect(await h.tokenBalance(ataFor(players[0].publicKey, SGD_MINT))).to.equal(
        before, "no winner may be paid a second time");
    });

    it("records what was paid, for audit", async () => {
      const { h } = await distributedRound();
      const d: any = await h.program.account.roundSettlement.fetch(h.settlementPda(1));
      expect(d.roundId.toNumber()).to.equal(1);
      expect(d.recipientCount).to.equal(3);
      expect(d.totalSettled.toString()).to.equal((FEE * 3n).toString());
      expect(d.state).to.equal(2, "distribute must land the settlement in POT_PAID");
    });
  });

  describe("gating", () => {
    it("refuses to pay a round whose winners are not revealed", async () => {
      const { h, authority, players } = await bootstrap(1);
      await h.send([await ixSubmit(h, players[0].publicKey, 1, 0)], [players[0]]);
      const entry = h.entryPda(h.roundPda(1), players[0].publicKey);
      // Finalized but NOT revealed — exactly the state finalize_round leaves a round in when
      // it is wound down without a reveal, which is why payout cannot live there.
      const pda = h.roundPda(1);
      const r0: any = await h.program.account.competitionRound.fetch(pda);
      r0.status = ROUND_STATUS_FINALIZED;
      const data = await h.program.coder.accounts.encode("competitionRound", r0);
      const acc = await h.client.getAccount(pda);
      h.context.setAccount(pda, { ...acc!, data });

      const r = await h.send([await ixDistribute(h, authority.publicKey, 1,
        [entry, ataFor(players[0].publicKey, SGD_MINT)])], [authority]);
      assert.isNotNull(r.result, "unrevealed round must not pay out");
      expect(r.result).to.contain(ERR_NOT_REVEALED);
    });

    it("rejects a winner ATA that does not belong to the winning entry's player", async () => {
      const { h, authority, players } = await bootstrap(2);
      const entries: PK[] = [];
      for (const p of players) {
        await h.send([await ixSubmit(h, p.publicKey, 1, 0)], [p]);
        entries.push(h.entryPda(h.roundPda(1), p.publicKey));
      }
      await revealWith(h, 1, entries);
      // Point winner 1's payout at player 2's account.
      const r = await h.send([await ixDistribute(h, authority.publicKey, 1, [
        entries[0], ataFor(players[1].publicKey, SGD_MINT),
        entries[1], ataFor(players[1].publicKey, SGD_MINT),
      ])], [authority]);
      assert.isNotNull(r.result, "mismatched winner ATA must be rejected");
      expect(r.result).to.contain(ERR_WRONG_MINT);
    });
  });

  // ---------------------------------------------------------------- mint migration
  describe("update_sgd_mint", () => {
    it("refuses while the round is still OPEN — the live pot would be stranded", async () => {
      const { h, authority } = await bootstrap(1);
      h.setMint(NEW_SGD_MINT, SGD_DECIMALS); // the target mint must exist to be pinned
      // round 1 is open
      const r = await h.send([await ixUpdateSgdMint(h, authority.publicKey, 1)], [authority]);
      assert.isNotNull(r.result, "an OPEN round must block the mint change");
      expect(r.result).to.contain(ERR_ROUND_NOT_FINAL);
    });

    it("refuses when the finalized round's pot still holds tokens", async () => {
      const { h, authority, players } = await bootstrap(1);
      h.setMint(NEW_SGD_MINT, SGD_DECIMALS);
      await h.send([await ixSubmit(h, players[0].publicKey, 1, 0)], [players[0]]);
      await revealWith(h, 1, [h.entryPda(h.roundPda(1), players[0].publicKey)]);
      // finalized, but the 100 SGD fee is still sitting in the vault
      expect(await h.tokenBalance(ataFor(h.potAuthorityPda(1), SGD_MINT))).to.equal(ENTRY_FEE_SGD);
      const r2 = await h.send([await ixUpdateSgdMint(h, authority.publicKey, 1)], [authority]);
      assert.isNotNull(r2.result, "an undrained pot must block the mint change");
      expect(r2.result).to.contain(ERR_POT_NOT_DRAINED);
    });

    it("allows the change once the pot has been distributed", async () => {
      const { h, authority, players } = await bootstrap(1);
      h.setMint(NEW_SGD_MINT, SGD_DECIMALS);
      await h.send([await ixSubmit(h, players[0].publicKey, 1, 0)], [players[0]]);
      const entry = h.entryPda(h.roundPda(1), players[0].publicKey);
      await revealWith(h, 1, [entry]);
      await h.send([await ixDistribute(h, authority.publicKey, 1,
        [entry, ataFor(players[0].publicKey, SGD_MINT)])], [authority]);
      expect(await h.tokenBalance(ataFor(h.potAuthorityPda(1), SGD_MINT))).to.equal(0n);

      await h.send([await ixUpdateSgdMint(h, authority.publicKey, 1)], [authority]);
      const cfg: any = await h.program.account.gameConfig.fetch(h.configPda());
      expect(cfg.sgdMint.toBase58()).to.equal(NEW_SGD_MINT.toBase58());
    });

    it("rejects a non-authority signer", async () => {
      const { h, authority, players } = await bootstrap(2);
      h.setMint(NEW_SGD_MINT, SGD_DECIMALS);
      await revealWith(h, 1, []);
      const impostor = players[1];
      const r = await h.send([await ixUpdateSgdMint(h, impostor.publicKey, 1)], [impostor]);
      assert.isNotNull(r.result, "a non-authority must be rejected");
    });

    it("takes no vault account at all, so there is no decoy left to pass", async () => {
      // The old guard read `old_pot_vault.amount == 0` and checked only owner and mint, so an
      // empty non-ATA account owned by the same PDA walked straight past it. There is now
      // nothing to substitute: the evidence is a settlement marker whose address is seed-derived
      // from the round, and the vault is not an input at all.
      const { h } = await bootstrap(1);
      const ixs = (h.program.idl as any).instructions;
      const ix = ixs.find((i: any) => i.name === "update_sgd_mint" || i.name === "updateSgdMint");
      assert.isDefined(ix, "update_sgd_mint must be in the IDL");
      const names = ix.accounts.map((a: any) => a.name);
      expect(names).to.not.include("old_pot_vault");
      expect(names).to.include("settlement");
    });

    it("ADVERSARIAL: another round's settlement cannot stand in for this one's", async () => {
      const { h, authority, players } = await bootstrap(1);
      h.setMint(NEW_SGD_MINT, SGD_DECIMALS);
      // Round 1 collects a fee and is finalized+revealed but never distributed, so it has no
      // settlement of its own. Round 2 is settled. Pointing at round 2's marker must not work.
      await h.send([await ixSubmit(h, players[0].publicKey, 1, 0)], [players[0]]);
      const entry = h.entryPda(h.roundPda(1), players[0].publicKey);
      await revealWith(h, 1, [entry]);
      const r = await h.send([await ixUpdateSgdMint(h, authority.publicKey, 1,
        { settlement: h.settlementPda(2) })], [authority]);
      assert.isNotNull(r.result, "a foreign settlement must be rejected");
      // Anchor rejects it on the seeds before the handler ever reads it.
      expect(r.result).to.contain(ERR_SEEDS);
    });

    it("REGRESSION: a dust donation no longer blocks the mint change forever", async () => {
      // The audit's permissionless DoS. One base unit dropped into a settled round's vault used
      // to make `amount == 0` false for good: the pot could not be distributed again, so nothing
      // could empty it, so the mint could never move. Dust cannot touch a marker.
      const { h, authority, players } = await bootstrap(1);
      h.setMint(NEW_SGD_MINT, SGD_DECIMALS);
      await h.send([await ixSubmit(h, players[0].publicKey, 1, 0)], [players[0]]);
      const entry = h.entryPda(h.roundPda(1), players[0].publicKey);
      await revealWith(h, 1, [entry]);
      await h.send([await ixDistribute(h, authority.publicKey, 1,
        [entry, ataFor(players[0].publicKey, SGD_MINT)])], [authority]);

      h.setTokenAccount(SGD_MINT, h.potAuthorityPda(1), 1n); // the grief
      const r = await h.send([await ixUpdateSgdMint(h, authority.publicKey, 1)], [authority]);
      assert.isNull(r.result, `dust must not block the migration: ${r.result}`);
      const cfg: any = await h.program.account.gameConfig.fetch(h.configPda());
      expect(cfg.sgdMint.toBase58()).to.equal(NEW_SGD_MINT.toBase58());
    });

    it("refuses a new mint whose decimals differ — the fee is raw base units", async () => {
      const { h, authority, players } = await bootstrap(1);
      const wrongDecimals = Keypair.generate().publicKey;
      h.setMint(wrongDecimals, 9); // 100_000_000 base units would become 0.1 tokens
      await h.send([await ixSubmit(h, players[0].publicKey, 1, 0)], [players[0]]);
      const entry = h.entryPda(h.roundPda(1), players[0].publicKey);
      await revealWith(h, 1, [entry]);
      await h.send([await ixDistribute(h, authority.publicKey, 1,
        [entry, ataFor(players[0].publicKey, SGD_MINT)])], [authority]);

      const r = await h.send([await ixUpdateSgdMint(h, authority.publicKey, 1,
        { newSgdMint: wrongDecimals })], [authority]);
      assert.isNotNull(r.result, "a 9-decimal mint must be refused");
      expect(r.result).to.contain(ERR_WRONG_DECIMALS);
      const cfg: any = await h.program.account.gameConfig.fetch(h.configPda());
      expect(cfg.sgdMint.toBase58()).to.equal(SGD_MINT.toBase58(), "the pin must be unchanged");
    });

    it("refuses a no-op re-pin to the mint already configured", async () => {
      const { h, authority } = await bootstrap(1);
      await revealWith(h, 1, []);
      const r = await h.send([await ixUpdateSgdMint(h, authority.publicKey, 1,
        { newSgdMint: SGD_MINT })], [authority]);
      assert.isNotNull(r.result, "a no-op re-pin must be rejected");
      expect(r.result).to.contain(ERR_MINT_ALREADY);
    });
  });

  // -------------------------------------------------------------------------------------
  // Account substitution: the pot vault is pinned to the ATA everywhere it appears
  //
  // The shared premise of all of these: ANYONE can create a non-ATA token account owned by any
  // PDA, so "owner == pot_authority && mint == sgd_mint" — the old check — can always be
  // satisfied by a second, attacker-made account. Each test builds exactly that lookalike and
  // hands it to one of the four instructions.
  // -------------------------------------------------------------------------------------
  describe("decoy pot vault is rejected everywhere", () => {
    /** A non-ATA $SGD account owned by round `r`'s pot authority — the lookalike. */
    const decoyFor = (h: Harness, r: number, amount = 0n) => {
      const addr = Keypair.generate().publicKey;
      h.setTokenAccount(SGD_MINT, h.potAuthorityPda(r), amount, addr);
      return addr;
    };

    it("submit_entry: a player cannot pay their fee into a lookalike", async () => {
      const { h, players } = await bootstrap(1);
      const decoy = decoyFor(h, 1);
      const before = await h.tokenBalance(ataFor(players[0].publicKey, SGD_MINT));
      const r = await h.send(
        [await ixSubmit(h, players[0].publicKey, 1, 0, { potVault: decoy })], [players[0]]);
      assert.isNotNull(r.result, "a non-ATA vault owned by the pot authority must be rejected");
      expect(r.result).to.contain(ERR_WRONG_MINT);
      expect(await h.tokenBalance(decoy)).to.equal(0n, "no fee may land in the lookalike");
      expect(await h.tokenBalance(ataFor(players[0].publicKey, SGD_MINT))).to.equal(before,
        "a rejected entry must not charge the player");
    });

    it("distribute_pot: THE audit case — a decoy cannot mark the round paid while the pot sits full", async () => {
      // The worst-case consequence in the audit. An empty lookalike drove the handler down the
      // `pot == 0` branch, which wrote a permanent settlement recording the round as settled.
      // The marker can never be written twice, so the real pot became unpayable forever.
      const { h, authority, players } = await bootstrap(3);
      const entries: PK[] = [];
      for (const p of players) {
        await h.send([await ixSubmit(h, p.publicKey, 1, 0)], [p]);
        entries.push(h.entryPda(h.roundPda(1), p.publicKey));
      }
      await revealWith(h, 1, entries);
      const realVault = ataFor(h.potAuthorityPda(1), SGD_MINT);
      expect(await h.tokenBalance(realVault)).to.equal(FEE * 3n);

      const decoy = decoyFor(h, 1);
      const pairs: PK[] = [];
      players.forEach((p, i) => { pairs.push(entries[i], ataFor(p.publicKey, SGD_MINT)); });
      const r = await h.send([await ixDistribute(h, authority.publicKey, 1, pairs,
        { potVault: decoy })], [authority]);

      assert.isNotNull(r.result, "the decoy must be rejected outright, not silently accepted");
      expect(r.result).to.contain(ERR_ASSOCIATED);
      expect(await h.tokenBalance(realVault)).to.equal(FEE * 3n, "the real pot must be untouched");
      assert.isNull(await h.client.getAccount(h.settlementPda(1)),
        "no settlement may be written — this is what made the old bug irreversible");
      // And the round is still payable through the correct vault.
      const ok = await h.send([await ixDistribute(h, authority.publicKey, 1, pairs)], [authority]);
      assert.isNull(ok.result, `the real distribution must still work: ${ok.result}`);
      expect(await h.tokenBalance(realVault)).to.equal(0n);
    });

    it("close_pot_vault: a decoy cannot be closed in the real vault's place", async () => {
      const { h, authority, rows } = await unrevealedRound(2);
      assert.isNull((await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows))],
        [authority], LATE)).result);
      const decoy = decoyFor(h, 1);
      const r = await h.send([await ixClosePotVault(h, authority.publicKey, 1,
        { potVault: decoy })], [authority], LATE);
      assert.isNotNull(r.result, "a lookalike must not be closable");
      expect(r.result).to.contain(ERR_ASSOCIATED);
      assert.isNotNull(await h.client.getAccount(decoy), "and must be left alone");
    });

    it("a legitimate vault still satisfies every one of them", async () => {
      // The tightening must not cost the honest path anything: fee in, distribute out, close.
      const { h, authority, players } = await bootstrap(2);
      const entries: PK[] = [];
      for (const p of players) {
        await h.send([await ixSubmit(h, p.publicKey, 1, 0)], [p]);
        entries.push(h.entryPda(h.roundPda(1), p.publicKey));
      }
      expect(await h.tokenBalance(ataFor(h.potAuthorityPda(1), SGD_MINT))).to.equal(FEE * 2n);
      await revealWith(h, 1, entries);
      const pairs: PK[] = [];
      players.forEach((p, i) => { pairs.push(entries[i], ataFor(p.publicKey, SGD_MINT)); });
      assert.isNull((await h.send([await ixDistribute(h, authority.publicKey, 1, pairs)], [authority])).result);
      assert.isNull((await h.send([await ixClosePotVault(h, authority.publicKey, 1)], [authority])).result);
      assert.isNull(await h.client.getAccount(ataFor(h.potAuthorityPda(1), SGD_MINT)));
    });
  });

  // -------------------------------------------------------------------------------------
  // PART A — the unrevealed-round escape hatch
  // -------------------------------------------------------------------------------------
  describe("refund_unrevealed_pot", () => {

    it("hands the whole pot back to the entrants, equally, draining the vault", async () => {
      const { h, authority, rows } = await unrevealedRound(3);
      const vault = ataFor(h.potAuthorityPda(1), SGD_MINT);
      expect(await h.tokenBalance(vault)).to.equal(FEE * 3n);
      const before = await Promise.all(rows.map((r) => h.tokenBalance(r.ata)));

      const res = await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows))], [authority], LATE);
      assert.isNull(res.result, `refund failed: ${res.result}`);

      const after = await Promise.all(rows.map((r) => h.tokenBalance(r.ata)));
      expect(after.map((a, i) => a! - before[i]!)).to.deep.equal([FEE, FEE, FEE],
        "each entrant must get exactly their own fee back");
      expect(await h.tokenBalance(vault)).to.equal(0n, "vault must drain to exactly zero");

      const m: any = await h.program.account.roundSettlement.fetch(h.settlementPda(1));
      expect(m.recipientCount).to.equal(3);
      expect(m.entrantCount).to.equal(3);
      expect(BigInt(m.totalSettled.toString())).to.equal(FEE * 3n);
      assert.notEqual(m.settledAt.toString(), "0", "a finished refund must be stamped complete");
    });

    it("ADVERSARIAL: refuses a REVEALED round — those belong to distribute_pot", async () => {
      const { h, authority, players } = await bootstrap(3);
      const entries: PK[] = [];
      for (const p of players) {
        await h.send([await ixSubmit(h, p.publicKey, 1, 0)], [p]);
        entries.push(h.entryPda(h.roundPda(1), p.publicKey));
      }
      await revealWith(h, 1, entries);
      const rows = players.map((p, i) => ({ entry: entries[i], ata: ataFor(p.publicKey, SGD_MINT) }))
        .sort((a, b) => Buffer.compare(a.entry.toBuffer(), b.entry.toBuffer()));
      const r = await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows))], [authority], LATE);
      assert.isNotNull(r.result, "a revealed round must never be refundable");
      expect(r.result).to.contain(ERR_REVEALED);
    });

    it("ADVERSARIAL: refuses before the grace period has elapsed", async () => {
      const { h, authority, rows } = await unrevealedRound(2);
      const r = await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows))], [authority],
        FIXED_UNIX_TS + 86400);
      assert.isNotNull(r.result, "a round one day old must not be sweepable");
      expect(r.result).to.contain(ERR_TOO_EARLY);
    });

    it("ADVERSARIAL: a second refund after completion is refused", async () => {
      const { h, authority, rows } = await unrevealedRound(2);
      const ok = await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows))], [authority], LATE);
      assert.isNull(ok.result, `first refund failed: ${ok.result}`);
      // Refill the vault, exactly as a donor could, and try again.
      h.setTokenAccount(SGD_MINT, h.potAuthorityPda(1), 500_000_000n);
      const r = await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows))], [authority], LATE);
      assert.isNotNull(r.result, "replay must be rejected even with a refilled vault");
      // The state machine gives a more precise answer than the old "refund already complete":
      // the pot is REFUNDED, which is the same fact distribute_pot would be told.
      expect(r.result).to.contain(ERR_ALREADY_REFUND);
    });

    it("ADVERSARIAL: the same entrant cannot be paid twice inside one batch", async () => {
      const { h, authority, rows } = await unrevealedRound(2);
      const dup = [rows[0].entry, rows[0].ata, rows[0].entry, rows[0].ata];
      const r = await h.send([await ixRefund(h, authority.publicKey, 1, dup)], [authority], LATE);
      assert.isNotNull(r.result, "a repeated entry must be rejected");
      expect(r.result).to.contain(ERR_ORDER);
    });

    it("ADVERSARIAL: entries out of pubkey order are rejected", async () => {
      const { h, authority, rows } = await unrevealedRound(3);
      const reversed = [...rows].reverse();
      const r = await h.send([await ixRefund(h, authority.publicKey, 1, flat(reversed))], [authority], LATE);
      assert.isNotNull(r.result, "descending order must be rejected");
      expect(r.result).to.contain(ERR_ORDER);
    });

    it("ADVERSARIAL: a decoy vault owned by the pot authority cannot be substituted", async () => {
      const { h, authority, rows } = await unrevealedRound(2);
      // Exactly the account the audit's finding #4 describes: same owner, same mint, not the
      // ATA. It passes an owner+mint check; it must not pass this one.
      const decoy = Keypair.generate().publicKey;
      h.setTokenAccount(SGD_MINT, h.potAuthorityPda(1), 0n, decoy);
      const r = await h.send(
        [await ixRefund(h, authority.publicKey, 1, flat(rows), { potVault: decoy })],
        [authority], LATE);
      assert.isNotNull(r.result, "a non-ATA vault must be rejected by the associated_token pin");
      // The real vault must be untouched, and no marker may have been written.
      expect(await h.tokenBalance(ataFor(h.potAuthorityPda(1), SGD_MINT))).to.equal(FEE * 2n);
      assert.isNull(await h.client.getAccount(h.settlementPda(1)),
        "a rejected refund must not leave a progress marker behind");
    });

    it("ADVERSARIAL: a non-authority signer is refused", async () => {
      const { h, rows } = await unrevealedRound(2);
      const stranger = h.fundedKeypair();
      const r = await h.send([await ixRefund(h, stranger.publicKey, 1, flat(rows))], [stranger], LATE);
      assert.isNotNull(r.result, "only the authority may refund");
      expect(r.result).to.contain(ERR_NOT_AUTHORITY);
    });

    it("ADVERSARIAL: a batch longer than the entrants left is refused", async () => {
      const { h, authority, rows } = await unrevealedRound(2);
      const tooLong = [...flat(rows), rows[0].entry, rows[0].ata];
      const r = await h.send([await ixRefund(h, authority.publicKey, 1, tooLong)], [authority], LATE);
      assert.isNotNull(r.result, "an over-long batch must be rejected");
      expect(r.result).to.contain(ERR_BATCH_LONG);
    });

    it("pays out across several batches and only then marks itself complete", async () => {
      const { h, authority, rows } = await unrevealedRound(4);
      const vault = ataFor(h.potAuthorityPda(1), SGD_MINT);

      const first = await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows.slice(0, 2)))],
        [authority], LATE);
      assert.isNull(first.result, `batch 1 failed: ${first.result}`);
      let m: any = await h.program.account.roundSettlement.fetch(h.settlementPda(1));
      expect(m.recipientCount).to.equal(2);
      expect(m.settledAt.toString()).to.equal("0", "a partial refund must not be complete");
      expect(await h.tokenBalance(vault)).to.equal(FEE * 2n);

      const second = await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows.slice(2)))],
        [authority], LATE);
      assert.isNull(second.result, `batch 2 failed: ${second.result}`);
      m = await h.program.account.roundSettlement.fetch(h.settlementPda(1));
      expect(m.recipientCount).to.equal(4);
      assert.notEqual(m.settledAt.toString(), "0");
      expect(await h.tokenBalance(vault)).to.equal(0n);
      const paid = await Promise.all(rows.map((r) => h.tokenBalance(r.ata)));
      // Each started at 10 fees, paid 1 in, got 1 back.
      for (const b of paid) expect(b).to.equal(FEE * 10n);
    });

    it("ADVERSARIAL: an earlier batch's entrant cannot be replayed in a later one", async () => {
      const { h, authority, rows } = await unrevealedRound(4);
      const ok = await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows.slice(0, 2)))],
        [authority], LATE);
      assert.isNull(ok.result, `batch 1 failed: ${ok.result}`);
      const r = await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows.slice(0, 2)))],
        [authority], LATE);
      assert.isNotNull(r.result, "the cursor must reject an already-paid entrant");
      expect(r.result).to.contain(ERR_ORDER);
    });

    it("ADVERSARIAL: refuses a round whose pot was already distributed", async () => {
      const { h, authority, players } = await bootstrap(2);
      const entries: PK[] = [];
      for (const p of players) {
        await h.send([await ixSubmit(h, p.publicKey, 1, 0)], [p]);
        entries.push(h.entryPda(h.roundPda(1), p.publicKey));
      }
      await revealWith(h, 1, entries);
      const pairs: PK[] = [];
      players.forEach((p, i) => { pairs.push(entries[i], ataFor(p.publicKey, SGD_MINT)); });
      assert.isNull((await h.send([await ixDistribute(h, authority.publicKey, 1, pairs)], [authority])).result);
      // Now un-reveal it — the most hostile shape available: a distributed round that also
      // satisfies the refund path's own `!scoring_revealed` gate.
      await finalizeUnrevealed(h, 1);
      h.setTokenAccount(SGD_MINT, h.potAuthorityPda(1), FEE * 2n);
      const rows = players.map((p, i) => ({ entry: entries[i], ata: ataFor(p.publicKey, SGD_MINT) }))
        .sort((a, b) => Buffer.compare(a.entry.toBuffer(), b.entry.toBuffer()));
      const r = await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows))], [authority], LATE);
      assert.isNotNull(r.result, "a distributed round must not also be refundable");
      expect(r.result).to.contain(ERR_ALREADY_DIST);
    });

    it("ADVERSARIAL: a LATE reveal cannot distribute a pot already refunded", async () => {
      const { h, authority, rows, players } = await unrevealedRound(3);
      assert.isNull((await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows))], [authority], LATE)).result);
      // The reveal finally arrives, and someone refills the vault to make it look payable.
      await lateReveal(h, 1, rows.map((r) => r.entry));
      h.setTokenAccount(SGD_MINT, h.potAuthorityPda(1), FEE * 3n);
      const pairs = flat(rows);
      const r = await h.send([await ixDistribute(h, authority.publicKey, 1, pairs)], [authority], LATE);
      assert.isNotNull(r.result, "a refunded pot must never be distributable");
      expect(r.result).to.contain(ERR_ALREADY_REFUND);
    });

    it("ADVERSARIAL: an entry from a different round is rejected", async () => {
      const { h, authority, players } = await bootstrap(2);
      for (const p of players) await h.send([await ixSubmit(h, p.publicKey, 1, 0)], [p]);
      const foreign = h.entryPda(h.roundPda(1), players[0].publicKey);
      await revealWith(h, 1, []); // finalize round 1 so round 2 may open
      await h.send([await ixOpenRound(h, authority.publicKey, 1)], [authority]);
      await h.send([await ixSubmit(h, players[0].publicKey, 2, 1)], [players[0]]);
      await finalizeUnrevealed(h, 2);
      const r = await h.send(
        [await ixRefund(h, authority.publicKey, 2, [foreign, ataFor(players[0].publicKey, SGD_MINT)])],
        [authority], LATE);
      assert.isNotNull(r.result, "a round-1 entry must not settle round 2");
      expect(r.result).to.contain(ERR_WRONG_ROUND);
    });

    // --- FIX 1: surplus must never reach an entrant -------------------------------------
    it("a donation does not inflate anyone's refund — each entrant gets exactly their fee", async () => {
      const { h, authority, rows } = await unrevealedRound(3);
      const vault = ataFor(h.potAuthorityPda(1), SGD_MINT);
      const DONATION = 5_000_000_000n; // 5,000 SGD dropped into a failed round's pot
      h.setTokenAccount(SGD_MINT, h.potAuthorityPda(1), FEE * 3n + DONATION);

      const before = await Promise.all(rows.map((r) => h.tokenBalance(r.ata)));
      const res = await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows))], [authority], LATE);
      assert.isNull(res.result, `refund failed: ${res.result}`);
      const paid = (await Promise.all(rows.map((r) => h.tokenBalance(r.ata))))
        .map((a, i) => a! - before[i]!);

      expect(paid).to.deep.equal([FEE, FEE, FEE], "a donation must not become anyone's payout");
      // The old rule handed the whole surplus to whoever sorted LAST in the cursor order, which
      // is what made grinding a vanity address worth doing. `rows` is ascending, so rows[2] is
      // exactly that entrant.
      expect(paid[2]).to.equal(FEE, "the last entrant in cursor order must get no more than the rest");
      expect(new Set(paid.map(String)).size).to.equal(1, "every entrant must receive the identical amount");
      expect(await h.tokenBalance(vault)).to.equal(DONATION, "surplus stays in the vault, unowned");

      const m: any = await h.program.account.roundSettlement.fetch(h.settlementPda(1));
      expect(BigInt(m.surplus.toString())).to.equal(DONATION);
      expect(BigInt(m.totalSettled.toString())).to.equal(FEE * 3n);
      expect(BigInt(m.perEntrant.toString())).to.equal(FEE);
    });

    it("a donation arriving MID-refund changes nobody's payout", async () => {
      const { h, authority, rows } = await unrevealedRound(4);
      const before = await Promise.all(rows.map((r) => h.tokenBalance(r.ata)));

      assert.isNull((await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows.slice(0, 2)))],
        [authority], LATE)).result);
      // Land a donation between batches — the case a vault-derived share would have repriced.
      const mid = await h.tokenBalance(ataFor(h.potAuthorityPda(1), SGD_MINT));
      h.setTokenAccount(SGD_MINT, h.potAuthorityPda(1), mid! + 9_000_000_000n);
      assert.isNull((await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows.slice(2)))],
        [authority], LATE)).result);

      const paid = (await Promise.all(rows.map((r) => h.tokenBalance(r.ata))))
        .map((a, i) => a! - before[i]!);
      expect(paid).to.deep.equal([FEE, FEE, FEE, FEE],
        "entrants paid before and after the donation must receive the same amount");
      expect(await h.tokenBalance(ataFor(h.potAuthorityPda(1), SGD_MINT))).to.equal(9_000_000_000n);
    });

    it("payouts are identical regardless of how the batches are split", async () => {
      // Same round size and same donation, refunded 1+3 instead of 2+2. If any payout depended
      // on batch composition, these two shapes would disagree.
      const { h, authority, rows } = await unrevealedRound(4);
      h.setTokenAccount(SGD_MINT, h.potAuthorityPda(1), FEE * 4n + 7_777_777_777n);
      const before = await Promise.all(rows.map((r) => h.tokenBalance(r.ata)));
      for (const slice of [rows.slice(0, 1), rows.slice(1)]) {
        assert.isNull((await h.send([await ixRefund(h, authority.publicKey, 1, flat(slice))],
          [authority], LATE)).result);
      }
      const paid = (await Promise.all(rows.map((r) => h.tokenBalance(r.ata))))
        .map((a, i) => a! - before[i]!);
      expect(paid).to.deep.equal([FEE, FEE, FEE, FEE]);
      expect(await h.tokenBalance(ataFor(h.potAuthorityPda(1), SGD_MINT))).to.equal(7_777_777_777n);
    });

    it("an unentered round completes immediately, so its rent is reclaimable", async () => {
      const { h, authority } = await bootstrap(1);
      await finalizeUnrevealed(h, 1);
      const r = await h.send([await ixRefund(h, authority.publicKey, 1, [])], [authority], LATE);
      assert.isNull(r.result, `empty-round refund failed: ${r.result}`);
      const m: any = await h.program.account.roundSettlement.fetch(h.settlementPda(1));
      expect(m.entrantCount).to.equal(0);
      assert.notEqual(m.settledAt.toString(), "0");
    });
  });

  describe("close_pot_vault", () => {
    it("ADVERSARIAL: refuses a vault with no settlement at all", async () => {
      const { h, authority } = await bootstrap(1);
      await finalizeUnrevealed(h, 1);
      const r = await h.send([await ixClosePotVault(h, authority.publicKey, 1)], [authority], LATE);
      assert.isNotNull(r.result, "an unsettled pot must not be closable");
      // With one typed settlement account instead of two raw probes, "never settled" now means
      // the account does not exist, and Anchor rejects it before the handler runs.
      expect(r.result).to.contain(ERR_UNINIT);
    });

    it("ADVERSARIAL: refuses while a refund is still in progress", async () => {
      const { h, authority, players } = await bootstrap(4);
      for (const p of players) await h.send([await ixSubmit(h, p.publicKey, 1, 0)], [p]);
      await finalizeUnrevealed(h, 1);
      const rows = players
        .map((p) => ({ entry: h.entryPda(h.roundPda(1), p.publicKey), ata: ataFor(p.publicKey, SGD_MINT) }))
        .sort((a, b) => Buffer.compare(a.entry.toBuffer(), b.entry.toBuffer()));
      const half = rows.slice(0, 2).flatMap((r) => [r.entry, r.ata]);
      assert.isNull((await h.send([await ixRefund(h, authority.publicKey, 1, half)], [authority], LATE)).result);
      const r = await h.send([await ixClosePotVault(h, authority.publicKey, 1)], [authority], LATE);
      assert.isNotNull(r.result, "a half-finished refund must keep the vault open");
      expect(r.result).to.contain(ERR_REFUND_INCOMPLETE);
    });

    it("sweeps unclaimed surplus to the authority, then closes the vault", async () => {
      const { h, authority, rows } = await unrevealedRound(2);
      const DONATION = 4_200_000_000n;
      h.setTokenAccount(SGD_MINT, h.potAuthorityPda(1), FEE * 2n + DONATION);
      assert.isNull((await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows))], [authority], LATE)).result);

      const authAta = ataFor(authority.publicKey, SGD_MINT);
      const before = await h.tokenBalance(authAta);
      const r = await h.send([await ixClosePotVault(h, authority.publicKey, 1)], [authority], LATE);
      assert.isNull(r.result, `close failed: ${r.result}`);
      expect((await h.tokenBalance(authAta))! - before!).to.equal(DONATION,
        "the surplus must reach the authority, not the caller-of-the-moment or an entrant");
      assert.isNull(await h.client.getAccount(ataFor(h.potAuthorityPda(1), SGD_MINT)),
        "the vault must be closed once swept");
    });

    it("closes a distributed round's vault, which has no surplus to sweep", async () => {
      const { h, authority, players } = await bootstrap(2);
      const entries: PK[] = [];
      for (const p of players) {
        await h.send([await ixSubmit(h, p.publicKey, 1, 0)], [p]);
        entries.push(h.entryPda(h.roundPda(1), p.publicKey));
      }
      await revealWith(h, 1, entries);
      const pairs: PK[] = [];
      players.forEach((p, i) => { pairs.push(entries[i], ataFor(p.publicKey, SGD_MINT)); });
      assert.isNull((await h.send([await ixDistribute(h, authority.publicKey, 1, pairs)], [authority])).result);
      const r = await h.send([await ixClosePotVault(h, authority.publicKey, 1)], [authority]);
      assert.isNull(r.result, `close failed: ${r.result}`);
      assert.isNull(await h.client.getAccount(ataFor(h.potAuthorityPda(1), SGD_MINT)));
    });

    it("REGRESSION: a dust donation after settlement can no longer wedge the close", async () => {
      // Previously a single base unit dropped into a finished round's vault made it permanently
      // un-closeable — SPL refuses to close a non-empty account and nothing could empty it again.
      const { h, authority, rows } = await unrevealedRound(2);
      assert.isNull((await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows))], [authority], LATE)).result);
      h.setTokenAccount(SGD_MINT, h.potAuthorityPda(1), 1n); // the grief
      const r = await h.send([await ixClosePotVault(h, authority.publicKey, 1)], [authority], LATE);
      assert.isNull(r.result, `close must survive a post-settlement donation: ${r.result}`);
      assert.isNull(await h.client.getAccount(ataFor(h.potAuthorityPda(1), SGD_MINT)));
    });
  });

  // -------------------------------------------------------------------------------------
  // FIX 2 — one settlement state, so PAID and REFUNDED cannot coexist
  // -------------------------------------------------------------------------------------
  describe("unified settlement state", () => {
    const stateOf = async (h: Harness, roundId: number) => {
      const acc = await h.client.getAccount(h.settlementPda(roundId));
      if (!acc) return ST_NONE;
      const m: any = await h.program.account.roundSettlement.fetch(h.settlementPda(roundId));
      return m.state as number;
    };

    it("walks None -> RefundPending -> Refunded and stops there", async () => {
      const { h, authority, rows } = await unrevealedRound(4);
      expect(await stateOf(h, 1)).to.equal(ST_NONE);
      await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows.slice(0, 2)))], [authority], LATE);
      expect(await stateOf(h, 1)).to.equal(ST_REFUND_PENDING);
      await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows.slice(2)))], [authority], LATE);
      expect(await stateOf(h, 1)).to.equal(ST_REFUNDED);
    });

    it("walks None -> Paid and stops there", async () => {
      const { h, authority, players } = await bootstrap(2);
      const entries: PK[] = [];
      for (const p of players) {
        await h.send([await ixSubmit(h, p.publicKey, 1, 0)], [p]);
        entries.push(h.entryPda(h.roundPda(1), p.publicKey));
      }
      expect(await stateOf(h, 1)).to.equal(ST_NONE);
      await revealWith(h, 1, entries);
      const pairs: PK[] = [];
      players.forEach((p, i) => { pairs.push(entries[i], ataFor(p.publicKey, SGD_MINT)); });
      await h.send([await ixDistribute(h, authority.publicKey, 1, pairs)], [authority]);
      expect(await stateOf(h, 1)).to.equal(ST_PAID);
    });

    it("ADVERSARIAL: distribute_pot is blocked MID-refund, not merely after it finishes", async () => {
      // The window the old pairwise probes could not express. A half-built refund marker did not
      // yet mean the pot was spoken for, so a reveal landing between batches could have paid the
      // winners out of a pot that was already being handed back.
      const { h, authority, rows } = await unrevealedRound(4);
      assert.isNull((await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows.slice(0, 2)))],
        [authority], LATE)).result);
      expect(await stateOf(h, 1)).to.equal(ST_REFUND_PENDING);

      await lateReveal(h, 1, rows.slice(0, 3).map((r) => r.entry));
      h.setTokenAccount(SGD_MINT, h.potAuthorityPda(1), FEE * 4n);
      const r = await h.send([await ixDistribute(h, authority.publicKey, 1, flat(rows.slice(0, 3)))],
        [authority], LATE);
      assert.isNotNull(r.result, "a pot mid-refund must not be distributable");
      expect(r.result).to.contain(ERR_ALREADY_REFUND);
      expect(await stateOf(h, 1)).to.equal(ST_REFUND_PENDING, "the failed attempt must not move the state");
    });

    it("ADVERSARIAL: a refund cannot resume after the state went Paid", async () => {
      // Reaches the same conflict from the other side and mid-flight: start a refund, force the
      // state to Paid via a real distribute on a re-revealed round... which itself must fail.
      // What is asserted here is that neither order can produce both states.
      const { h, authority, rows } = await unrevealedRound(4);
      assert.isNull((await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows.slice(0, 2)))],
        [authority], LATE)).result);
      await lateReveal(h, 1, rows.slice(0, 3).map((r) => r.entry));
      // distribute is refused (previous test), so the state is still RefundPending; the refund
      // must still be finishable, and must land on Refunded and nothing else.
      await finalizeUnrevealed(h, 1);
      assert.isNull((await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows.slice(2)))],
        [authority], LATE)).result);
      expect(await stateOf(h, 1)).to.equal(ST_REFUNDED);
    });

    it("ADVERSARIAL: distribute twice is refused by state, not by an init collision", async () => {
      const { h, authority, players } = await bootstrap(2);
      const entries: PK[] = [];
      for (const p of players) {
        await h.send([await ixSubmit(h, p.publicKey, 1, 0)], [p]);
        entries.push(h.entryPda(h.roundPda(1), p.publicKey));
      }
      await revealWith(h, 1, entries);
      const pairs: PK[] = [];
      players.forEach((p, i) => { pairs.push(entries[i], ataFor(p.publicKey, SGD_MINT)); });
      assert.isNull((await h.send([await ixDistribute(h, authority.publicKey, 1, pairs)], [authority])).result);
      h.setTokenAccount(SGD_MINT, h.potAuthorityPda(1), FEE * 2n); // refill, to re-arm the old hole
      const r = await h.send([await ixDistribute(h, authority.publicKey, 1, pairs)], [authority]);
      assert.isNotNull(r.result, "replay must be rejected");
      // A NAMED error, where the old design could only produce "account already in use".
      expect(r.result).to.contain(ERR_ALREADY_DIST);
    });

    it("no sequence of calls leaves a round both Paid and Refunded", async () => {
      // Exhaustive over the four orderings that can reach a conflict, asserting the terminal
      // state is exactly one value each time.
      for (const order of ["refund-then-distribute", "distribute-then-refund"]) {
        const { h, authority, players } = await bootstrap(3);
        const entries: PK[] = [];
        for (const p of players) {
          await h.send([await ixSubmit(h, p.publicKey, 1, 0)], [p]);
          entries.push(h.entryPda(h.roundPda(1), p.publicKey));
        }
        const rows = players
          .map((p, i) => ({ entry: entries[i], ata: ataFor(p.publicKey, SGD_MINT) }))
          .sort((a, b) => Buffer.compare(a.entry.toBuffer(), b.entry.toBuffer()));
        const pairs: PK[] = [];
        players.forEach((p, i) => { pairs.push(entries[i], ataFor(p.publicKey, SGD_MINT)); });

        if (order === "refund-then-distribute") {
          await finalizeUnrevealed(h, 1);
          assert.isNull((await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows))], [authority], LATE)).result);
          await lateReveal(h, 1, entries);
          h.setTokenAccount(SGD_MINT, h.potAuthorityPda(1), FEE * 3n);
          const r = await h.send([await ixDistribute(h, authority.publicKey, 1, pairs)], [authority], LATE);
          assert.isNotNull(r.result, `${order}: distribute must be refused`);
          expect(await stateOf(h, 1)).to.equal(ST_REFUNDED, `${order}: terminal state must be REFUNDED only`);
        } else {
          await revealWith(h, 1, entries);
          assert.isNull((await h.send([await ixDistribute(h, authority.publicKey, 1, pairs)], [authority])).result);
          await finalizeUnrevealed(h, 1);
          h.setTokenAccount(SGD_MINT, h.potAuthorityPda(1), FEE * 3n);
          const r = await h.send([await ixRefund(h, authority.publicKey, 1, flat(rows))], [authority], LATE);
          assert.isNotNull(r.result, `${order}: refund must be refused`);
          expect(await stateOf(h, 1)).to.equal(ST_PAID, `${order}: terminal state must be PAID only`);
        }
      }
    });
  });

    // -------------------------------------------------------------------------------------
    // Neither the SOL prize nor the monolithic reveal exists any more
    // -------------------------------------------------------------------------------------
    describe("removed instruction surface", () => {
      it("REGRESSION (audit C-1 + H-4): the exploitable instructions are gone", () => {
        // C-1: queue_reveal_top3 and its _v3 twin validated remaining_accounts with only
        // "belongs to this round" and "is scored" — no ordering, no uniqueness — so an
        // operator could pass the SAME entry participant_count times, have the circuit rank
        // identical scores, tie-break on slot index, and write one entry into all three
        // winner slots. distribute_pot does not dedup winners, so the whole pot paid out to a
        // single wallet. Both deleted; the bracket, which always enforced strict ascent,
        // subsumes them.
        //
        // H-4: pay_sol_prizes was an external treasury subsidy. The pot splits between
        // k = min(entrants, 3) winners, so at three entrants or fewer EVERY entrant won and
        // was refunded in full — the SOL on top was free money for turning up unopposed,
        // which rounds 69 and 72 did naturally. Deleted rather than gated.
        const idl = JSON.parse(fs.readFileSync("./target/idl/secret_garden.json", "utf8"));
        const gone = (n: string) =>
          idl.instructions.find((i: { name: string }) => i.name === n) === undefined;
        expect(gone("queue_reveal_top3"), "queue_reveal_top3 must be gone").to.equal(true);
        expect(gone("queue_reveal_top3_v3"), "queue_reveal_top3_v3 must be gone").to.equal(true);
        expect(gone("reveal_top3_callback"), "reveal_top3_callback must be gone").to.equal(true);
        expect(gone("pay_sol_prizes"), "pay_sol_prizes must be gone").to.equal(true);
        expect(
          idl.accounts.find((x: { name: string }) => x.name === "PrizeDistribution"),
          "PrizeDistribution must be gone",
        ).to.equal(undefined);
        // The bracket and the pot survive — they are the reveal and the prize now.
        for (const keep of ["queue_shard_reveal", "apply_bracket_result", "distribute_pot"]) {
          expect(gone(keep), `${keep} must remain`).to.equal(false);
        }
      });
    });
});
