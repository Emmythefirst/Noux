/**
 * top_up_budget and set_attribution_key on a LOCAL validator. Every "must fail" asserts the specific program error.
 *   solana-test-validator --reset --ledger <dir> --upgradeable-program <PROGRAM_ID> program/target/deploy/noux.so <AUTHORITY_PUBKEY>
 *   UPGRADE_AUTHORITY=/path/authority.json pnpm tsx scripts/campaign-controls-local.ts
 */
import fs from "node:fs"; import crypto from "node:crypto";
import { Connection, Ed25519Program, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, getAccount, mintTo, transfer, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { buildClaimMessage, idl, salePda } from "@noux/core";

const conn = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const PROGRAM = new PublicKey((idl as any).address);
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.UPGRADE_AUTHORITY!, "utf8"))));
const [admin, feeWallet, merchant, rando, payer, keyA, keyB, keyC] = Array.from({ length: 8 }, () => Keypair.generate());
const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(rando), { commitment: "confirmed" }));
const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM)[0];
const programData = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
const results: { name: string; ok: boolean }[] = [];
const rec = (name: string, ok: boolean, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };
const errText = (e: any) => String(e?.message ?? e) + " " + (e?.logs ?? e?.transactionLogs ?? []).join(" ");
async function expectOk(name: string, f: () => Promise<unknown>) { try { await f(); rec(name, true); } catch (e) { rec(name, false, errText(e).replace(/\s+/g, " ").slice(0, 260)); } }
async function expectErr(name: string, re: RegExp, f: () => Promise<unknown>) { try { await f(); rec(name, false, "succeeded but must fail"); } catch (e) { const t = errText(e); rec(name, re.test(t), re.test(t) ? "" : "wrong error: " + t.replace(/\s+/g, " ").slice(0, 260)); } }
const fund = async (k: Keypair) => { await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 10e9), "confirmed"); };
for (const k of [authority, merchant, rando, payer]) await fund(k);

await program.methods.initConfig(admin.publicKey, feeWallet.publicKey, 100).accounts({ authority: authority.publicKey, config: configPda, programData, systemProgram: SystemProgram.programId } as any).signers([authority]).rpc();
const mint = await createMint(conn, authority, authority.publicKey, null, 6);
const ata = (o: PublicKey) => getAssociatedTokenAddressSync(mint, o, true);
const id = new anchor.BN(crypto.randomBytes(6)), campaign = PublicKey.findProgramAddressSync([Buffer.from("campaign"), merchant.publicKey.toBuffer(), id.toArrayLike(Buffer, "le", 8)], PROGRAM)[0];
const BUDGET0 = 10_000n;
await program.methods.createCampaign(id, 1500, new anchor.BN(BUDGET0.toString()), keyA.publicKey, [...Buffer.from("localnet")], 0).accounts({ merchant: merchant.publicKey, mint, config: configPda, campaign, systemProgram: SystemProgram.programId } as any).signers([merchant]).rpc();
const camp = async () => (program.account as any).campaign.fetch(campaign);
const budget = async () => BigInt((await camp()).commissionBudget.toString()), spent = async () => BigInt((await camp()).commissionSpent.toString());

const topUp = (signer: Keypair, amount: bigint | number) => program.methods.topUpBudget(new anchor.BN(amount.toString())).accounts({ merchant: signer.publicKey, campaign } as any).signers([signer]).rpc();
const setKey = (signer: Keypair, key: PublicKey) => program.methods.setAttributionKey(key).accounts({ merchant: signer.publicKey, campaign } as any).signers([signer]).rpc();

const distributor = Keypair.generate().publicKey;
for (const o of [merchant.publicKey, distributor, feeWallet.publicKey]) await getOrCreateAssociatedTokenAccount(conn, authority, mint, o);
/** Opens a sale (claim signed by `signKey`), pays `amount` into its vault, and returns functions to settle it. */
async function openSale(signKey: Keypair, amount: bigint) {
  const buyer = Keypair.generate(); await fund(buyer); await getOrCreateAssociatedTokenAccount(conn, authority, mint, buyer.publicKey); await mintTo(conn, authority, mint, ata(buyer.publicKey), authority, amount);
  const nonce = crypto.randomBytes(32), expiry = Math.floor(Date.now() / 1000) + 600, sale = salePda(PROGRAM, campaign, nonce);
  const msg = buildClaimMessage({ programId: PROGRAM, cluster: "localnet", campaign, distributor, buyer: buyer.publicKey, expiry, price: amount, nonce });
  const openIx = await program.methods.openSale([...nonce], new anchor.BN(expiry), new anchor.BN(amount.toString())).accounts({ payer: payer.publicKey, campaign, distributor, buyer: buyer.publicKey, mint, sale, saleVault: ata(sale), instructions: new PublicKey("Sysvar1nstructions1111111111111111111111111"), tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId } as any).instruction();
  const open = () => sendAndConfirmTransaction(conn, new Transaction().add(Ed25519Program.createInstructionWithPrivateKey({ privateKey: signKey.secretKey, message: msg }), openIx), [payer]);
  const fundVault = () => transfer(conn, buyer, ata(buyer.publicKey), ata(sale), buyer, amount);
  const settle = async () => { const ix = await program.methods.settleSale().accounts({ caller: merchant.publicKey, campaign, sale, saleVault: ata(sale), merchantAta: ata(merchant.publicKey), distributorAta: ata(distributor), feeAta: ata(feeWallet.publicKey), rentPayer: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID } as any).instruction(); await sendAndConfirmTransaction(conn, new Transaction().add(ix), [merchant]); const s: any = await (program.account as any).sale.fetch(sale); return { commission: BigInt(s.commissionAmount.toString()), merchant: BigInt(s.merchantAmount.toString()), fee: BigInt(s.feeAmount.toString()), status: Object.keys(s.status)[0] }; };
  return { open, fundVault, settle, sale };
}
const fullSale = async (key: Keypair, amount = 100_000n) => { const s = await openSale(key, amount); await s.open(); await s.fundVault(); return s.settle(); };

// ============ top_up_budget ============
console.log("-- top_up_budget");
await expectErr("a wallet that is not the merchant cannot top up", /NotMerchant|not the campaign merchant/i, () => topUp(rando, 5_000));
await expectErr("the campaign creator's own authority is not enough either (only the campaign's merchant)", /NotMerchant|not the campaign merchant/i, () => topUp(authority, 5_000));
await expectErr("a zero top-up is refused", /BadBudgetIncrease|greater than zero/i, () => topUp(merchant, 0));
await expectErr("a top-up that would overflow u64 is refused", /BadBudgetIncrease|overflow/i, () => topUp(merchant, (1n << 64n) - 1n));
rec("a refused top-up changed nothing", (await budget()) === BUDGET0, `${await budget()}`);
{ const s1 = await fullSale(keyA); rec("BEFORE the top-up the cap bites: 15% of 100000 would be 15000, commission is capped at the 10000 budget", s1.commission === 10_000n && (await spent()) === 10_000n, `commission ${s1.commission}`); }
await expectOk("the merchant tops up by 20000", () => topUp(merchant, 20_000));
rec("budget is now 30000 and what was spent is untouched", (await budget()) === 30_000n && (await spent()) === 10_000n, `${await budget()} / spent ${await spent()}`);
{ const s2 = await fullSale(keyA); rec("AFTER the top-up the next sale pays the full 15000 commission", s2.commission === 15_000n && s2.merchant + s2.commission + s2.fee === 100_000n, `commission ${s2.commission}`); }
{ const s3 = await fullSale(keyA); const s4 = await fullSale(keyA); rec("budget runs out again: 5000 left, then 0", s3.commission === 5_000n && s4.commission === 0n && (await spent()) === 30_000n, `${s3.commission}, ${s4.commission}`); }
await expectOk("an EXHAUSTED campaign can be topped up and sells with commission again", () => topUp(merchant, 15_000));
{ const s5 = await fullSale(keyA); rec("...and the next sale pays commission again", s5.commission === 15_000n, `commission ${s5.commission}`); }
{ // a sale opened BEFORE a top-up settles under the budget at settle time, terms (bps) frozen
  const inflight = await openSale(keyA, 100_000n); await inflight.open(); await inflight.fundVault();
  const before = await budget(); await topUp(merchant, 1_000); rec("top-up while a sale is in flight", (await budget()) === before + 1_000n);
  const r = await inflight.settle(); rec("the in-flight sale still settles with exact parts", r.status === "settled" && r.merchant + r.commission + r.fee === 100_000n, `${r.commission}`);
}

// ============ set_attribution_key ============
console.log("-- set_attribution_key");
await expectErr("a wallet that is not the merchant cannot rotate the key", /NotMerchant|not the campaign merchant/i, () => setKey(rando, keyB.publicKey));
await expectErr("the all-zero key is refused", /InvalidKey|all-zero/i, () => setKey(merchant, PublicKey.default));
rec("a refused rotation changed nothing", (await camp()).attributionKey.equals(keyA.publicKey));
const preRotation = await openSale(keyA, 100_000n); await preRotation.open(); await preRotation.fundVault(); // opened under key A, settled after the rotation
await expectOk("the merchant rotates the key from A to B", () => setKey(merchant, keyB.publicKey));
rec("the campaign now trusts B", (await camp()).attributionKey.equals(keyB.publicKey));
{ const old = await openSale(keyA, 100_000n); await expectErr("a claim signed by the OLD key A is now rejected on-chain", /WrongSigner|not signed by the campaign attribution key/i, () => old.open()); }
{ const fresh = await openSale(keyB, 100_000n); await expectOk("a claim signed by the NEW key B opens", () => fresh.open()); await fresh.fundVault(); const r = await fresh.settle(); rec("...and settles with exact parts", r.merchant + r.commission + r.fee === 100_000n); }
{ const r = await preRotation.settle(); rec("a sale opened under the old key BEFORE the rotation still settles", r.status === "settled" && r.merchant + r.commission + r.fee === 100_000n); }
await expectOk("rotating again (B to C) works", () => setKey(merchant, keyC.publicKey));
{ const b = await openSale(keyB, 100_000n); await expectErr("the previous key B is rejected after rotating to C", /WrongSigner|not signed by the campaign attribution key/i, () => b.open()); }
await expectOk("rotating back to A works", () => setKey(merchant, keyA.publicKey));
{ const a = await openSale(keyA, 100_000n); await expectOk("A works again", () => a.open()); }

const failed = results.filter((r) => !r.ok); console.log(`\n${results.length - failed.length}/${results.length} checks passed`); process.exit(failed.length ? 1 : 0);
