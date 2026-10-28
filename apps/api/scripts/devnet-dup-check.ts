/**
 * Devnet proof of the settle_sale `dup` fix, without touching the live config: a throwaway test mint, a campaign whose merchant is ALSO the
 * distributor (same wallet), real open_sale + settle_sale on the deployed program. Funded from the deploy wallet (~0.1 SOL, mostly returned).
 *   set -a; . ../../.env; set +a; pnpm tsx scripts/devnet-dup-check.ts
 */
import fs from "node:fs"; import crypto from "node:crypto";
import { Connection, Ed25519Program, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, getAccount, mintTo, transfer, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { buildClaimMessage, idl, salePda } from "@noux/core";

const conn = new Connection(process.env.RPC_URL!, "confirmed");
const PROGRAM = new PublicKey((idl as any).address);
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf8"))));
const [merchant, buyer, attest] = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(deployer), { commitment: "confirmed" }));
const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM)[0];
const cfg: any = await (program.account as any).config.fetch(configPda);
for (const k of [merchant, buyer]) await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: k.publicKey, lamports: 30_000_000 })), [deployer]);
const mint = await createMint(conn, deployer, deployer.publicKey, null, 6);
const ata = (o: PublicKey) => getAssociatedTokenAddressSync(mint, o, true);
const id = new anchor.BN(crypto.randomBytes(6));
const campaign = PublicKey.findProgramAddressSync([Buffer.from("campaign"), merchant.publicKey.toBuffer(), id.toArrayLike(Buffer, "le", 8)], PROGRAM)[0];
await program.methods.createCampaign(id, 1500, new anchor.BN(1_000_000), attest.publicKey, [...Buffer.from("devnet\0\0")], 0).accounts({ merchant: merchant.publicKey, mint, config: configPda, campaign, systemProgram: SystemProgram.programId } as any).signers([merchant]).rpc();
await getOrCreateAssociatedTokenAccount(conn, deployer, mint, buyer.publicKey);
await mintTo(conn, deployer, mint, ata(buyer.publicKey), deployer, 100_000);
const nonce = crypto.randomBytes(32), expiry = Math.floor(Date.now() / 1000) + 600, sale = salePda(PROGRAM, campaign, nonce);
const msg = buildClaimMessage({ programId: PROGRAM, cluster: "devnet", campaign, distributor: merchant.publicKey, buyer: buyer.publicKey, expiry, price: 100_000n, nonce });
const openIx = await program.methods.openSale([...nonce], new anchor.BN(expiry), new anchor.BN(100_000)).accounts({ payer: deployer.publicKey, campaign, distributor: merchant.publicKey, buyer: buyer.publicKey, mint, sale, saleVault: ata(sale), instructions: new PublicKey("Sysvar1nstructions1111111111111111111111111"), tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId } as any).instruction();
await sendAndConfirmTransaction(conn, new Transaction().add(Ed25519Program.createInstructionWithPrivateKey({ privateKey: attest.secretKey, message: msg }), openIx), [deployer]);
await transfer(conn, buyer, ata(buyer.publicKey), ata(sale), buyer, 100_000n);
const pre = [merchant.publicKey, cfg.feeOwner].map((o: PublicKey) => createAssociatedTokenAccountIdempotentInstruction(merchant.publicKey, ata(o), o, mint));
const settleIx = await program.methods.settleSale().accounts({ caller: merchant.publicKey, campaign, sale, saleVault: ata(sale), merchantAta: ata(merchant.publicKey), distributorAta: ata(merchant.publicKey), feeAta: ata(cfg.feeOwner), rentPayer: deployer.publicKey, tokenProgram: TOKEN_PROGRAM_ID } as any).instruction();
let ok = true;
try { await sendAndConfirmTransaction(conn, new Transaction().add(...pre, settleIx), [merchant]); } catch (e) { ok = false; console.log("FAIL settle:", String((e as any).message).slice(0, 300)); }
if (ok) {
  const s: any = await (program.account as any).sale.fetch(sale);
  const m = (await getAccount(conn, ata(merchant.publicKey))).amount, f = (await getAccount(conn, ata(cfg.feeOwner))).amount;
  console.log(`status settled=${"settled" in s.status}; merchant-wallet (merchant+distributor roles) received ${m} (want 99000), fee wallet received ${f} (want 1000)`);
  console.log(m === 99_000n && f === 1_000n && "settled" in s.status ? "PASS devnet: settle works when merchant == distributor" : "FAIL: amounts wrong");
}
process.exit(ok ? 0 : 1);
