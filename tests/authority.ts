/**
 * Two-step handover of `GameConfig.authority`, and the decimals guard on mint pinning.
 *
 * The handover's whole safety property is that the INCOMING address signs its own acceptance,
 * so a mistyped or unowned address can never take control — it just never accepts. These tests
 * exercise that from both directions: the nominee can accept, nobody else can, and the current
 * authority keeps every power it had until the moment acceptance lands.
 */
import * as anchor from "@anchor-lang/core";
import { assert, expect } from "chai";
import { Harness } from "./harness.ts";
import { SGD_MINT, SGD_DECIMALS, ixSetSgdMint } from "./sgd.ts";

const { PublicKey, Keypair } = anchor.web3;
type PK = anchor.web3.PublicKey;

const ERR_NOT_AUTHORITY = "0x1771"; // 6001 NotAuthority
const ERR_WRONG_DECIMALS = "0x17bb"; // 6075 WrongSgdDecimals
const ERR_NO_PENDING = "0x17bc"; // 6076 NoPendingAuthority
const ERR_NOT_PENDING = "0x17bd"; // 6077 NotPendingAuthority
const ERR_BAD_PROPOSAL = "0x17be"; // 6078 InvalidAuthorityProposal

const ixInitConfig = (h: Harness, authority: PK) =>
  h.program.methods
    .initializeConfig()
    .accountsStrict({
      authority,
      config: h.configPda(),
      systemProgram: h.systemProgram(),
    })
    .instruction();
const ixPropose = (h: Harness, authority: PK, newAuthority: PK) =>
  h.program.methods
    .proposeAuthorityTransfer(newAuthority)
    .accountsStrict({ authority, config: h.configPda() })
    .instruction();
const ixAccept = (h: Harness, newAuthority: PK) =>
  h.program.methods
    .acceptAuthorityTransfer()
    .accountsStrict({ newAuthority, config: h.configPda() })
    .instruction();
const ixCancel = (h: Harness, authority: PK) =>
  h.program.methods
    .cancelAuthorityTransfer()
    .accountsStrict({ authority, config: h.configPda() })
    .instruction();
/** A convenient authority-gated probe that is not part of the transfer machinery itself. */
const ixAddOperator = (h: Harness, authority: PK, op: PK) =>
  h.program.methods
    .addOperator(op)
    .accountsStrict({ authority, config: h.configPda() })
    .instruction();
const ixSetPaused = (h: Harness, authority: PK, v: boolean) =>
  h.program.methods
    .setPaused(v)
    .accountsStrict({ authority, config: h.configPda() })
    .instruction();

async function bootstrap() {
  const h = await Harness.create();
  const authority = h.payer;
  await h.send([await ixInitConfig(h, authority.publicKey)], [authority]);
  return { h, authority };
}
const cfg = (h: Harness) =>
  h.program.account.gameConfig.fetch(h.configPda()) as any;

describe("authority handover", () => {
  describe("propose / accept", () => {
    it("moves control only when the nominee signs", async () => {
      const { h, authority } = await bootstrap();
      const next = h.fundedKeypair();

      await h.send(
        [await ixPropose(h, authority.publicKey, next.publicKey)],
        [authority],
      );
      let c = await cfg(h);
      expect(c.authority.toBase58()).to.equal(
        authority.publicKey.toBase58(),
        "proposing must not move control",
      );
      expect(c.pendingAuthority.toBase58()).to.equal(next.publicKey.toBase58());

      const r = await h.send([await ixAccept(h, next.publicKey)], [next]);
      assert.isNull(r.result, `accept failed: ${r.result}`);
      c = await cfg(h);
      expect(c.authority.toBase58()).to.equal(next.publicKey.toBase58());
      expect(c.pendingAuthority.toBase58()).to.equal(
        PublicKey.default.toBase58(),
        "a completed transfer must leave no stale proposal",
      );
    });

    it("the old authority keeps every power until acceptance lands", async () => {
      const { h, authority } = await bootstrap();
      const next = h.fundedKeypair();
      await h.send(
        [await ixPropose(h, authority.publicKey, next.publicKey)],
        [authority],
      );

      // Mid-transfer: the incumbent still administers normally.
      const stillWorks = await h.send(
        [
          await ixAddOperator(
            h,
            authority.publicKey,
            Keypair.generate().publicKey,
          ),
        ],
        [authority],
      );
      assert.isNull(
        stillWorks.result,
        `incumbent lost power at propose time: ${stillWorks.result}`,
      );
      const paused = await h.send(
        [await ixSetPaused(h, authority.publicKey, true)],
        [authority],
      );
      assert.isNull(
        paused.result,
        `pause gate rejected the incumbent mid-transfer: ${paused.result}`,
      );

      // And the nominee has nothing yet.
      const tooEarly = await h.send(
        [await ixAddOperator(h, next.publicKey, Keypair.generate().publicKey)],
        [next],
      );
      assert.isNotNull(
        tooEarly.result,
        "a nominee must have no power before accepting",
      );
      expect(tooEarly.result).to.contain(ERR_NOT_AUTHORITY);
    });

    it("power swaps in exactly one step at accept", async () => {
      const { h, authority } = await bootstrap();
      const next = h.fundedKeypair();
      await h.send(
        [await ixPropose(h, authority.publicKey, next.publicKey)],
        [authority],
      );
      await h.send([await ixAccept(h, next.publicKey)], [next]);

      const oldTries = await h.send(
        [
          await ixAddOperator(
            h,
            authority.publicKey,
            Keypair.generate().publicKey,
          ),
        ],
        [authority],
      );
      assert.isNotNull(
        oldTries.result,
        "the old authority must lose control at accept",
      );
      expect(oldTries.result).to.contain(ERR_NOT_AUTHORITY);

      const newTries = await h.send(
        [await ixAddOperator(h, next.publicKey, Keypair.generate().publicKey)],
        [next],
      );
      assert.isNull(
        newTries.result,
        `the new authority must have control: ${newTries.result}`,
      );
    });

    it("ADVERSARIAL: a stranger cannot accept someone else's proposal", async () => {
      const { h, authority } = await bootstrap();
      const next = h.fundedKeypair();
      const stranger = h.fundedKeypair();
      await h.send(
        [await ixPropose(h, authority.publicKey, next.publicKey)],
        [authority],
      );

      const r = await h.send(
        [await ixAccept(h, stranger.publicKey)],
        [stranger],
      );
      assert.isNotNull(r.result, "only the nominee may accept");
      expect(r.result).to.contain(ERR_NOT_PENDING);
      const c = await cfg(h);
      expect(c.authority.toBase58()).to.equal(authority.publicKey.toBase58());
      expect(c.pendingAuthority.toBase58()).to.equal(
        next.publicKey.toBase58(),
        "a rejected acceptance must leave the proposal intact",
      );
    });

    it("ADVERSARIAL: the current authority cannot accept on the nominee's behalf", async () => {
      // The point of the design: control cannot move without the incoming key proving it exists.
      const { h, authority } = await bootstrap();
      const next = h.fundedKeypair();
      await h.send(
        [await ixPropose(h, authority.publicKey, next.publicKey)],
        [authority],
      );
      const r = await h.send(
        [await ixAccept(h, authority.publicKey)],
        [authority],
      );
      assert.isNotNull(
        r.result,
        "the incumbent must not be able to complete its own handover",
      );
      expect(r.result).to.contain(ERR_NOT_PENDING);
    });

    it("ADVERSARIAL: a typo'd address simply never accepts, and is recoverable", async () => {
      // The failure this whole mechanism exists to prevent. `wrong` is an address nobody holds
      // a key for, so it can never sign — control stays put and the proposal can be withdrawn.
      const { h, authority } = await bootstrap();
      const wrong = Keypair.generate().publicKey;
      await h.send(
        [await ixPropose(h, authority.publicKey, wrong)],
        [authority],
      );
      expect((await cfg(h)).authority.toBase58()).to.equal(
        authority.publicKey.toBase58(),
      );

      await h.send([await ixCancel(h, authority.publicKey)], [authority]);
      const c = await cfg(h);
      expect(c.pendingAuthority.toBase58()).to.equal(
        PublicKey.default.toBase58(),
      );
      expect(c.authority.toBase58()).to.equal(
        authority.publicKey.toBase58(),
        "the deployment must still be controlled after a mistake",
      );
    });

    it("ADVERSARIAL: a non-authority cannot propose", async () => {
      const { h } = await bootstrap();
      const stranger = h.fundedKeypair();
      const r = await h.send(
        [await ixPropose(h, stranger.publicKey, stranger.publicKey)],
        [stranger],
      );
      assert.isNotNull(r.result, "only the authority may nominate a successor");
      expect(r.result).to.contain(ERR_NOT_AUTHORITY);
    });

    it("ADVERSARIAL: the zero address and the incumbent are both rejected as proposals", async () => {
      const { h, authority } = await bootstrap();
      const zero = await h.send(
        [await ixPropose(h, authority.publicKey, PublicKey.default)],
        [authority],
      );
      assert.isNotNull(
        zero.result,
        "the zero address is the 'nothing pending' sentinel",
      );
      expect(zero.result).to.contain(ERR_BAD_PROPOSAL);

      const self = await h.send(
        [await ixPropose(h, authority.publicKey, authority.publicKey)],
        [authority],
      );
      assert.isNotNull(
        self.result,
        "proposing the incumbent is a no-op worth naming",
      );
      expect(self.result).to.contain(ERR_BAD_PROPOSAL);
    });
  });

  describe("cancel", () => {
    it("clears a pending proposal so it can no longer be accepted", async () => {
      const { h, authority } = await bootstrap();
      const next = h.fundedKeypair();
      await h.send(
        [await ixPropose(h, authority.publicKey, next.publicKey)],
        [authority],
      );
      await h.send([await ixCancel(h, authority.publicKey)], [authority]);

      const r = await h.send([await ixAccept(h, next.publicKey)], [next]);
      assert.isNotNull(r.result, "a cancelled proposal must not be acceptable");
      expect(r.result).to.contain(ERR_NO_PENDING);
      expect((await cfg(h)).authority.toBase58()).to.equal(
        authority.publicKey.toBase58(),
      );
    });

    it("ADVERSARIAL: a non-authority cannot cancel", async () => {
      const { h, authority } = await bootstrap();
      const next = h.fundedKeypair();
      await h.send(
        [await ixPropose(h, authority.publicKey, next.publicKey)],
        [authority],
      );
      const r = await h.send([await ixCancel(h, next.publicKey)], [next]);
      assert.isNotNull(
        r.result,
        "the nominee must not be able to cancel its own nomination",
      );
      expect(r.result).to.contain(ERR_NOT_AUTHORITY);
      expect((await cfg(h)).pendingAuthority.toBase58()).to.equal(
        next.publicKey.toBase58(),
      );
    });

    it("cancelling with nothing pending is a named error, not a silent no-op", async () => {
      const { h, authority } = await bootstrap();
      const r = await h.send(
        [await ixCancel(h, authority.publicKey)],
        [authority],
      );
      assert.isNotNull(r.result);
      expect(r.result).to.contain(ERR_NO_PENDING);
    });

    it("accepting with nothing pending is refused", async () => {
      const { h } = await bootstrap();
      const stranger = h.fundedKeypair();
      const r = await h.send(
        [await ixAccept(h, stranger.publicKey)],
        [stranger],
      );
      assert.isNotNull(r.result, "there is nothing to accept");
      expect(r.result).to.contain(ERR_NO_PENDING);
    });

    it("re-proposing replaces the nominee, and the first one can no longer accept", async () => {
      const { h, authority } = await bootstrap();
      const first = h.fundedKeypair();
      const second = h.fundedKeypair();
      await h.send(
        [await ixPropose(h, authority.publicKey, first.publicKey)],
        [authority],
      );
      await h.send(
        [await ixPropose(h, authority.publicKey, second.publicKey)],
        [authority],
      );

      const stale = await h.send([await ixAccept(h, first.publicKey)], [first]);
      assert.isNotNull(
        stale.result,
        "a superseded nominee must not be able to accept",
      );
      expect(stale.result).to.contain(ERR_NOT_PENDING);

      const ok = await h.send([await ixAccept(h, second.publicKey)], [second]);
      assert.isNull(
        ok.result,
        `the current nominee must be able to accept: ${ok.result}`,
      );
      expect((await cfg(h)).authority.toBase58()).to.equal(
        second.publicKey.toBase58(),
      );
    });
  });

  describe("interaction with operators mid-transfer", () => {
    it("an operator's powers are unaffected by a pending proposal or by the handover", async () => {
      // Operators are gated by `is_operator_or_authority`, which reads `config.operators` and
      // `config.authority` — neither is touched while a proposal is open, and the operator list
      // survives the handover intact.
      const { h, authority } = await bootstrap();
      const op = h.fundedKeypair();
      const next = h.fundedKeypair();
      await h.send(
        [await ixAddOperator(h, authority.publicKey, op.publicKey)],
        [authority],
      );

      await h.send(
        [await ixPropose(h, authority.publicKey, next.publicKey)],
        [authority],
      );
      let c = await cfg(h);
      expect(c.operatorCount).to.equal(1);
      expect(c.operators[0].toBase58()).to.equal(op.publicKey.toBase58());

      await h.send([await ixAccept(h, next.publicKey)], [next]);
      c = await cfg(h);
      expect(c.operatorCount).to.equal(
        1,
        "the handover must not disturb the operator list",
      );
      expect(c.operators[0].toBase58()).to.equal(op.publicKey.toBase58());
      expect(c.authority.toBase58()).to.equal(next.publicKey.toBase58());

      // An operator still cannot do authority-only things, before or after.
      const r = await h.send(
        [await ixAddOperator(h, op.publicKey, Keypair.generate().publicKey)],
        [op],
      );
      assert.isNotNull(
        r.result,
        "operators must not gain authority powers from a handover",
      );
      expect(r.result).to.contain(ERR_NOT_AUTHORITY);
    });
  });

  describe("$SGD mint decimals", () => {
    it("set_sgd_mint refuses a mint whose decimals are not SGD_DECIMALS", async () => {
      const { h, authority } = await bootstrap();
      const wrong = Keypair.generate().publicKey;
      h.setMint(wrong, 9); // 9 decimals: ENTRY_FEE_SGD would silently become 0.1 tokens
      const r = await h.send(
        [await ixSetSgdMint(h, authority.publicKey, wrong)],
        [authority],
      );
      assert.isNotNull(r.result, "a 9-decimal mint must be refused");
      expect(r.result).to.contain(ERR_WRONG_DECIMALS);
      expect((await cfg(h)).sgdMint.toBase58()).to.equal(
        PublicKey.default.toBase58(),
        "a refused pin must leave the mint unset",
      );
    });

    it("set_sgd_mint accepts the correct decimals", async () => {
      const { h, authority } = await bootstrap();
      h.setMint(SGD_MINT, SGD_DECIMALS);
      const r = await h.send(
        [await ixSetSgdMint(h, authority.publicKey, SGD_MINT)],
        [authority],
      );
      assert.isNull(r.result, `a 6-decimal mint must be accepted: ${r.result}`);
      expect((await cfg(h)).sgdMint.toBase58()).to.equal(SGD_MINT.toBase58());
    });

    it("a 0-decimal mint is refused too — the fee would become a million tokens", async () => {
      const { h, authority } = await bootstrap();
      const wrong = Keypair.generate().publicKey;
      h.setMint(wrong, 0);
      const r = await h.send(
        [await ixSetSgdMint(h, authority.publicKey, wrong)],
        [authority],
      );
      assert.isNotNull(r.result);
      expect(r.result).to.contain(ERR_WRONG_DECIMALS);
    });
  });
});
