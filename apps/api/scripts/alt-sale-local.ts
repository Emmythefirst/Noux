/**
 * Builds a REAL sale on a local validator whose open and payment transactions are v0 transactions that use an address lookup table,
 * and writes what apps/web/test/verify-alt.test.ts needs to run verifyReceipt against it.
 *   solana-test-validator --reset --ledger /tmp/noux-ledger-alt --upgradeable-program <PROGRAM_ID> program/target/deploy/noux.so <AUTHORITY_PUBKEY>
 *   UPGRADE_AUTHORITY=/path/authority.json OUT=/path/fixture.json pnpm tsx scripts/alt-sale-local.ts
 */
import fs from "node:fs"; import crypto from "node:crypto";
import { AddressLookupTableProgram, Connection, Ed25519Program, Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction, SYSVAR_INSTRUCTIONS_PUBKEY, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo, createTransferInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { buildClaimMessage, idl, salePda } from "@noux/core";

const conn = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const PROGRAM = new PublicKey((idl as any).address);
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.UPGRADE_AUTHORITY!, "utf8"))));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fund = async (k: Keypair) => { await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 5e9), "confirmed"); };
const [admin, feeWallet, merchant, distributor, buyer, payer, attest] = Array.from({ length: 7 }, () => Keypair.generate());
const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(payer), { commitment: "confirmed" }));
const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM)[0];
const programData = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
for (const k of [authority, merchant, buyer, payer]) await fund(k);

await program.methods.initConfig(admin.publicKey, feeWallet.publicKey, 100).accounts({ authority: authority.publicKey, config: configPda, programData, systemProgram: SystemProgram.programId } as any).signers([authority]).rpc();
const mint = await createMint(conn, authority, authority.publicKey, null, 6);
const ata = (o: PublicKey) => getAssociatedTokenAddressSync(mint, o, true);
const id = new anchor.BN(crypto.randomBytes(6));
const campaign = PublicKey.findProgramAddressSync([Buffer.from("campaign"), merchant.publicKey.toBuffer(), id.toArrayLike(Buffer, "le", 8)], PROGRAM)[0];
await program.methods.createCampaign(id, 1500, new anchor.BN(1_000_000), attest.publicKey, [...Buffer.from("localnet")], 0).accounts({ merchant: merchant.publicKey, mint, config: configPda, campaign, systemProgram: SystemProgram.programId } as any).signers([merchant]).rpc();
await getOrCreateAssociatedTokenAccount(conn, authority, mint, buyer.publicKey);
const PRICE = 100_000n;
await mintTo(conn, authority, mint, ata(buyer.publicKey), authority, PRICE);

const nonce = crypto.randomBytes(32), expiry = Math.floor(Date.now() / 1000) + 600;
const sale = salePda(PROGRAM, campaign, nonce), vault = ata(sale);
const msg = buildClaimMessage({ programId: PROGRAM, cluster: "localnet", campaign, distributor: distributor.publicKey, buyer: buyer.publicKey, expiry, price: PRICE, nonce });

// address lookup table holding every non-signer account the two transactions use
const slot = await conn.getSlot("finalized");
const [createIx, altAddr] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot });
const members = [campaign, distributor.publicKey, buyer.publicKey, mint, sale, vault, SYSVAR_INSTRUCTIONS_PUBKEY, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId, ata(buyer.publicKey)];
await sendAndConfirmTransaction(conn, new Transaction().add(createIx, AddressLookupTableProgram.extendLookupTable({ lookupTable: altAddr, authority: payer.publicKey, payer: payer.publicKey, addresses: members })), [payer]);
let alt = (await conn.getAddressLookupTable(altAddr)).value; for (let i = 0; i < 40 && !(alt && alt.state.addresses.length === members.length); i++) { await sleep(500); alt = (await conn.getAddressLookupTable(altAddr)).value; }
await sleep(2000); // an extended table is usable from the next slot

const v0 = async (ixs: any[], signers: Keypair[]) => {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const t = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message([alt!]));
  t.sign(signers); const sig = await conn.sendTransaction(t, { skipPreflight: false }); await conn.confirmTransaction(sig, "confirmed"); return sig;
};
const openIx = await program.methods.openSale([...nonce], new anchor.BN(expiry), new anchor.BN(PRICE.toString())).accounts({ payer: payer.publicKey, campaign, distributor: distributor.publicKey, buyer: buyer.publicKey, mint, sale, saleVault: vault, instructions: SYSVAR_INSTRUCTIONS_PUBKEY, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId } as any).instruction();
const openSig = await v0([Ed25519Program.createInstructionWithPrivateKey({ privateKey: attest.secretKey, message: msg }), openIx], [payer]);
const paySig = await v0([createTransferInstruction(ata(buyer.publicKey), vault, buyer.publicKey, PRICE)], [payer, buyer]);

const pre = [merchant.publicKey, distributor.publicKey, feeWallet.publicKey].map((o) => createAssociatedTokenAccountIdempotentInstruction(merchant.publicKey, ata(o), o, mint));
const settleIx = await program.methods.settleSale().accounts({ caller: merchant.publicKey, campaign, sale, saleVault: vault, merchantAta: ata(merchant.publicKey), distributorAta: ata(distributor.publicKey), feeAta: ata(feeWallet.publicKey), rentPayer: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID } as any).instruction();
await sendAndConfirmTransaction(conn, new Transaction().add(...pre, settleIx), [merchant]);

// prove the two transactions really used the lookup table (otherwise this test proves nothing)
const usedAlt = async (sig: string) => { const t: any = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }); return { version: t.version, lookups: t.transaction.message.addressTableLookups?.length ?? 0, loaded: (t.meta.loadedAddresses?.writable.length ?? 0) + (t.meta.loadedAddresses?.readonly.length ?? 0) }; };
const info = { open: await usedAlt(openSig), pay: await usedAlt(paySig) };
console.log("lookup-table usage", JSON.stringify(info));
if (info.open.version !== 0 || info.open.lookups < 1 || info.pay.version !== 0 || info.pay.lookups < 1) throw new Error("the transactions did not use a lookup table");
fs.writeFileSync(process.env.OUT!, JSON.stringify({ sale: sale.toBase58(), openSig, paySig, gross: "100000", split: { merchant: "84000", distributor: "15000", protocolFee: "1000" }, usedAlt: info }));
console.log("fixture written");
process.exit(0);
