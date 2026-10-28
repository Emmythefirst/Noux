/**
 * Dev utility: open a sale on a campaign (claim signed with the local attribution key) and fund its vault from the deploy wallet.
 * Used by the browser wallet end-to-end test to create something refundable. Prints {"sale": "..."}.
 *   RPC_URL=... ATTRIBUTION_KEY_FILE=... pnpm tsx scripts/open-funded-sale.ts <campaign> [price-base-units]
 */
import fs from "node:fs"; import os from "node:os"; import crypto from "node:crypto";
import { Connection, Ed25519Program, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, transfer, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { buildClaimMessage, idl, salePda } from "@noux/core";

const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const conn = new Connection(process.env.RPC_URL!, "confirmed");
const payer = load(`${os.homedir()}/.config/solana/id.json`), attest = load(process.env.ATTRIBUTION_KEY_FILE!);
const PROGRAM = new PublicKey((idl as any).address), USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const campaign = new PublicKey(process.argv[2]), price = BigInt(process.argv[3] ?? "10000");
const distributor = Keypair.generate().publicKey;
const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(payer), { commitment: "confirmed" }));
const nonce = crypto.randomBytes(32), expiry = Math.floor(Date.now() / 1000) + 600;
const msg = buildClaimMessage({ programId: PROGRAM, cluster: "devnet", campaign, distributor, buyer: payer.publicKey, expiry, price, nonce });
const sale = salePda(PROGRAM, campaign, nonce), vault = getAssociatedTokenAddressSync(USDC, sale, true);
const open = await program.methods.openSale([...nonce], new anchor.BN(expiry), new anchor.BN(price.toString())).accounts({
  payer: payer.publicKey, campaign, distributor, buyer: payer.publicKey, mint: USDC, sale, saleVault: vault, instructions: new PublicKey("Sysvar1nstructions1111111111111111111111111"),
  tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId } as any).instruction();
await sendAndConfirmTransaction(conn, new Transaction().add(Ed25519Program.createInstructionWithPrivateKey({ privateKey: attest.secretKey, message: msg }), open), [payer]);
await transfer(conn, payer, getAssociatedTokenAddressSync(USDC, payer.publicKey), vault, payer, price);
console.log(JSON.stringify({ sale: sale.toBase58(), buyer: payer.publicKey.toBase58(), vault: vault.toBase58() }));
process.exit(0);
