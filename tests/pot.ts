/**
 * $SGD entry-fee pot: collection, equal split, and the security properties that matter once
 * this holds real money.
 *
 * The split is EQUAL between however many winners the reveal actually named — not tiered — so
 * every podium finisher breaks even at 3 entrants and profits above that.
 */
import * as anchor from "@anchor-lang/core";
import { assert, expect } from "chai";
import { Harness, ataFor, TOKEN_PROGRAM_ID } from "./harness.ts";
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
    potDistribution: h.potDistPda(roundId),
    potAuthority: h.potAuthorityPda(roundId),
    potVault: ataFor(h.potAuthorityPda(roundId), SGD_MINT),
    sgdMint: SGD_MINT, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: h.systemProgram(),
    ...(override ?? {}),
  }).remainingAccounts(pairs.map((p) => ({ pubkey: p, isSigner: false, isWritable: true }))).instruction();

/** A second $SGD-shaped mint, to migrate TO. */
const NEW_SGD_MINT = anchor.web3.Keypair.generate().publicKey;

const ixUpdateSgdMint = (h: Harness, authority: PK, roundId: number, override?: any) =>
  h.program.methods.updateSgdMint().accountsStrict({
    authority, config: h.configPda(), round: h.roundPda(roundId),
    oldPotVault: ataFor(h.potAuthorityPda(roundId), SGD_MINT),
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
      const d: any = await h.program.account.potDistribution.fetch(h.potDistPda(1));
      expect(d.roundId.toNumber()).to.equal(1);
      expect(d.winnerCount).to.equal(3);
      expect(d.totalPaid.toString()).to.equal((FEE * 3n).toString());
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

    it("rejects an empty token account that is not this round's pot vault", async () => {
      const { h, authority, players } = await bootstrap(1);
      h.setMint(NEW_SGD_MINT, SGD_DECIMALS);
      await revealWith(h, 1, []);
      // a player's own (empty-of-nothing) $SGD account holds the right mint but the wrong owner
      const decoy = ataFor(players[0].publicKey, SGD_MINT);
      const r = await h.send([await ixUpdateSgdMint(h, authority.publicKey, 1,
        { oldPotVault: decoy })], [authority]);
      assert.isNotNull(r.result, "a decoy vault must be rejected");
      expect(r.result).to.contain(ERR_WRONG_MINT);
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
});
