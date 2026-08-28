/**
 * Shared $SGD fixtures for the bankrun suites.
 *
 * `submit_entry` now charges a mandatory 100 SGD fee, so every suite that submits an entry
 * needs a configured mint, a funded player token account and the round's pot vault. Seeding
 * those through `setAccount` keeps the tests dependency-free while still exercising the real
 * SPL Token program (dumped into tests/fixtures) for the transfer itself.
 */
import * as anchor from "@anchor-lang/core";
import {
  Harness,
  ataFor,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "./harness.ts";

type PK = anchor.web3.PublicKey;

/** Mint used by every bankrun suite. Fixed so failures are reproducible. */
export const SGD_MINT = anchor.web3.Keypair.generate().publicKey;
export const ENTRY_FEE_SGD = 100_000_000n; // 100 SGD at 6dp
export const SGD_DECIMALS = 6;

/** Pin the mint on-chain (one-time setter). */
export const ixSetSgdMint = (h: Harness, authority: PK, mint: PK = SGD_MINT) =>
  h.program.methods
    .setSgdMint()
    .accountsStrict({ authority, config: h.configPda(), sgdMint: mint })
    .instruction();

/**
 * Seed the mint, give `players` a funded token account each, and create the round's pot vault.
 * Returns the vault address. Call AFTER the config exists and BEFORE any submit_entry.
 */
export function seedSgd(
  h: Harness,
  players: PK[],
  roundIds: number[] = [1, 2, 3],
  perPlayer: bigint = ENTRY_FEE_SGD * 10n,
  mint: PK = SGD_MINT,
): void {
  h.setMint(mint, SGD_DECIMALS);
  for (const p of players) h.setTokenAccount(mint, p, perPlayer);
  // The pot vaults ARE seeded here, and that is a harness workaround, not the real flow: on
  // devnet `open_round` creates each vault itself (paid by the operator). bankrun's VM cannot
  // run SPL Token's account-init path, so the vault is pre-materialised and open_round's
  // `init_if_needed` adopts it — still proving mint/authority validation, just not creation.
  // Vault CREATION is covered by the devnet end-to-end run instead.
  for (const r of roundIds) h.setTokenAccount(mint, h.potAuthorityPda(r), 0n);
}

/** The four accounts `submit_entry` gained. */
export function feeAccounts(h: Harness, player: PK, roundId: number, mint: PK = SGD_MINT) {
  return {
    sgdMint: mint,
    playerSgdAta: ataFor(player, mint),
    potVault: ataFor(h.potAuthorityPda(roundId), mint),
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}

/** The five accounts `open_round` gained when it took over pot-vault creation. */
export function openRoundAccounts(h: Harness, nextRoundId: number, mint: PK = SGD_MINT) {
  const potAuthority = h.potAuthorityPda(nextRoundId);
  return {
    potAuthority,
    potVault: ataFor(potAuthority, mint),
    sgdMint: mint,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  };
}
