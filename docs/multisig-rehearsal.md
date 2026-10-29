# Multisig rehearsal (devnet, Squads v4)

Date: 2026-10-29. Script: `apps/api/scripts/multisig-rehearsal.ts` (`DEVNET=1`). Squads v4 program `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`.

The real Noux program was **not** touched. The script deploys a throwaway copy of the program, hands that copy to a 2-of-3 multisig, and runs the operations we will need on mainnet. 11 of 11 checks passed:

1. A 2-of-3 multisig and its vault were created on devnet.
2. The copy's upgrade authority moved to the vault. The deploy wallet could no longer change or use it (the loader refused with "Incorrect authority").
3. A program upgrade ran through the multisig: write the buffer, hand the buffer to the vault, create the proposal, approve it twice, execute. The deployed slot advanced and the vault stayed the authority.
4. The vault signed an ordinary instruction (a transfer) through a proposal. This is the same mechanism `update_config` needs from the config admin, which only has to be a signer.
5. The vault closed the program through a proposal and the rent (1.564 SOL) came back.

## What this does not prove
- The "1 of 2 approvals cannot execute" check passes on any execution error, not only the not-enough-approvals error. The threshold itself is Squads' own behaviour; the check is a smoke test, not proof.
- `update_config` itself was not run through the vault, because the throwaway copy has a different program id from the one compiled into it. Only the signing mechanism was shown.
- Members were three keys on one machine. A real setup needs three separate people or devices, ideally hardware wallets.
- Devnet only. Nothing was done on mainnet.

## Gotchas found
- The Squads SDK's `rpc.*` helpers return after sending, not after confirming. Wait for confirmation before the next step.
- `vaultTransactionCreate` takes the creator as a public key plus a `signers` list. Passing it without signers fails with a misleading error that hides the real one.
- A buffer costs about 1.56 SOL of rent while it exists. Once its authority moves to the vault, `solana program show --buffers` does not list it under your wallet. Find it with `--buffer-authority <vault>`. A script that dies after `write-buffer` strands that SOL, so print the buffer address first.
- The vault is a PDA, so `set-upgrade-authority` needs `--skip-new-upgrade-authority-signer-check`. Double-check the vault address first; a wrong one makes the program permanently non-upgradable.

## For mainnet
Move two things to the multisig vault: the program upgrade authority, and the config `admin` (via `update_config`, signed by the vault). Do the program first, with the real members. Keep the old deploy wallet out of the loop afterwards.
