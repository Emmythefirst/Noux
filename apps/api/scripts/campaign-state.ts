/**
 * set_campaign_state (pause / resume / permanent end) and its enforcement in open_sale, on a LOCAL validator, or on devnet with DEVNET=1 (UPGRADE_AUTHORITY = a funded devnet wallet; uses a throwaway test mint and the live config's fee wallet; costs a few cents of SOL).
 * Every "must fail" asserts the specific program error.
 *   solana-test-validator --reset --ledger <dir> --upgradeable-program <PROGRAM_ID> program/target/deploy/noux.so <AUTHORITY_PUBKEY>
 *   UPGRADE_AUTHORITY=/path/authority.json pnpm tsx scripts/campaign-state.ts
 */
import fs from "node:fs"; import crypto from "node:crypto";
import { Connection, Ed25519Program, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, getAccount, mintTo, transfer, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { buildClaimMessage, idl, salePda } from "@noux/core";

const conn = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const PROGRAM = new PublicKey((idl as any).address);
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.UPGRADE_AUTHORITY!, "utf8"))));
const [admin, merchant, rando, payer, keyA, keyB, keyC] = Array.from({ length: 7 }, () => Keypair.generate());
let feeWalletPk = Keypair.generate().publicKey; // devnet: replaced by the live config's fee wallet
const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(rando), { commitment: "confirmed" }));
const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM)[0];
const programData = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
const results: { name: string; ok: boolean }[] = [];
const rec = (name: string, ok: boolean, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };
const errText = (e: any) => String(e?.message ?? e) + " " + (e?.logs ?? e?.transactionLogs ?? []).join(" ");
async function expectOk(name: string, f: () => Promise<unknown>) { try { await f(); rec(name, true); } catch (e) { rec(name, false, errText(e).replace(/\s+/g, " ").slice(0, 260)); } }
async function expectErr(name: string, re: RegExp, f: () => Promise<unknown>) { try { await f(); rec(name, false, "succeeded but must fail"); } catch (e) { const t = errText(e); rec(name, re.test(t), re.test(t) ? "" : "wrong error: " + t.replace(/\s+/g, " ").slice(0, 260)); } }
const DEV = !!process.env.DEVNET, CLUSTER = DEV ? "devnet" : "localnet";
// local: airdrops; devnet: small transfers from the funded wallet (airdrops are rate-limited)
const fund = async (k: Keypair, sol = 10) => { if (!DEV) { await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, sol * 1e9), "confirmed"); return; } await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: k.publicKey, lamports: Math.round(sol * 1e9) })), [authority]); };
if (DEV) { for (const [k, sol] of [[merchant, 0.03], [rando, 0.01], [payer, 0.1]] as const) await fund(k, sol); } else { for (const k of [authority, merchant, rando, payer]) await fund(k); }

if (DEV) { const cfg: any = await (program.account as any).config.fetch(configPda); feeWalletPk = cfg.feeOwner; } // the live config's fee wallet
else await program.methods.initConfig(admin.publicKey, feeWalletPk, 100).accounts({ authority: authority.publicKey, config: configPda, programData, systemProgram: SystemProgram.programId } as any).signers([authority]).rpc();
const mint = await createMint(conn, authority, authority.publicKey, null, 6);
const ata = (o: PublicKey) => getAssociatedTokenAddressSync(mint, o, true);
const id = new anchor.BN(crypto.randomBytes(6)), campaign = PublicKey.findProgramAddressSync([Buffer.from("campaign"), merchant.publicKey.toBuffer(), id.toArrayLike(Buffer, "le", 8)], PROGRAM)[0];
const BUDGET0 = 10_000n;
await program.methods.createCampaign(id, 1500, new anchor.BN(BUDGET0.toString()), keyA.publicKey, [...Buffer.from(CLUSTER + "\0".repeat(8 - CLUSTER.length))], 0).accounts({ merchant: merchant.publicKey, mint, config: configPda, campaign, systemProgram: SystemProgram.programId } as any).signers([merchant]).rpc();
const camp = async () => (program.account as any).campaign.fetch(campaign);
const budget = async () => BigInt((await camp()).commissionBudget.toString()), spent = async () => BigInt((await camp()).commissionSpent.toString());

const _unusedTopUp = (signer: Keypair, amount: bigint | number) => program.methods.topUpBudget(new anchor.BN(amount.toString())).accounts({ merchant: signer.publicKey, campaign } as any).signers([signer]).rpc();
const _unusedSetKey = (signer: Keypair, key: PublicKey) => program.methods.setAttributionKey(key).accounts({ merchant: signer.publicKey, campaign } as any).signers([signer]).rpc();

const distributor = Keypair.generate().publicKey;
for (const o of [merchant.publicKey, distributor, feeWalletPk]) await getOrCreateAssociatedTokenAccount(conn, authority, mint, o);
/** Opens a sale (claim signed by `signKey`), pays `amount` into its vault, and returns functions to settle it. */
async function openSale(signKey: Keypair, amount: bigint) {
  const buyer = Keypair.generate(); await fund(buyer, DEV ? 0.003 : 10); await getOrCreateAssociatedTokenAccount(conn, authority, mint, buyer.publicKey); await mintTo(conn, authority, mint, ata(buyer.publicKey), authority, amount);
  const nonce = crypto.randomBytes(32), expiry = Math.floor(Date.now() / 1000) + 600, sale = salePda(PROGRAM, campaign, nonce);
  const msg = buildClaimMessage({ programId: PROGRAM, cluster: CLUSTER, campaign, distributor, buyer: buyer.publicKey, expiry, price: amount, nonce });
  const openIx = await program.methods.openSale([...nonce], new anchor.BN(expiry), new anchor.BN(amount.toString())).accounts({ payer: payer.publicKey, campaign, distributor, buyer: buyer.publicKey, mint, sale, saleVault: ata(sale), instructions: new PublicKey("Sysvar1nstructions1111111111111111111111111"), tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, control: PublicKey.findProgramAddressSync([Buffer.from("control"), campaign.toBuffer()], PROGRAM)[0] } as any).instruction();
  const open = () => sendAndConfirmTransaction(conn, new Transaction().add(Ed25519Program.createInstructionWithPrivateKey({ privateKey: signKey.secretKey, message: msg }), openIx), [payer]);
  const fundVault = () => transfer(conn, buyer, ata(buyer.publicKey), ata(sale), buyer, amount);
  const settle = async () => { const ix = await program.methods.settleSale().accounts({ caller: merchant.publicKey, campaign, sale, saleVault: ata(sale), merchantAta: ata(merchant.publicKey), distributorAta: ata(distributor), feeAta: ata(feeWalletPk), rentPayer: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID } as any).instruction(); await sendAndConfirmTransaction(conn, new Transaction().add(ix), [merchant]); const s: any = await (program.account as any).sale.fetch(sale); return { commission: BigInt(s.commissionAmount.toString()), merchant: BigInt(s.merchantAmount.toString()), fee: BigInt(s.feeAmount.toString()), status: Object.keys(s.status)[0] }; };
  return { open, fundVault, settle, sale, nonce, expiry, msg, buyer };
}
const fullSale = async (key: Keypair, amount = 100_000n) => { const s = await openSale(key, amount); await s.open(); await s.fundVault(); return s.settle(); };


const controlPda = PublicKey.findProgramAddressSync([Buffer.from("control"), campaign.toBuffer()], PROGRAM)[0];
const setState = (signer: Keypair, state: "active" | "paused" | "ended") => program.methods.setCampaignState({ [state]: {} } as any).accounts({ merchant: signer.publicKey, campaign, control: controlPda, systemProgram: SystemProgram.programId } as any).signers([signer]).rpc();
const ctl = async () => { try { const c: any = await (program.account as any).campaignControl.fetch(controlPda); return Object.keys(c.state)[0]; } catch { return null; } };
const sellsOk = async (name: string) => { try { const s = await fullSale(keyA); rec(name, s.status === "settled" && s.merchant + s.commission + s.fee === 100_000n); } catch (e) { rec(name, false, errText(e).replace(/\s+/g, " ").slice(0, 200)); } };
const NOT_ACTIVE = /CampaignNotActive|paused or ended/i, BAD_STATE = /BadStateChange|not allowed/i, NOT_MERCHANT = /NotMerchant|not the campaign merchant/i;

console.log("-- a campaign that was never paused has no control account and sells normally");
rec("no control account exists yet", (await ctl()) === null);
await sellsOk("a never-paused campaign sells and settles (the missing control account means Active)");

console.log("-- who may change the state");
await expectErr("a wallet that is not the merchant cannot pause", NOT_MERCHANT, () => setState(rando, "paused"));
await expectErr("a wallet that is not the merchant cannot end", NOT_MERCHANT, () => setState(rando, "ended"));
rec("refused attempts created nothing and changed nothing", (await ctl()) === null);
await expectErr("'active' on a campaign that is already active is refused (a mistaken call is visible)", BAD_STATE, () => setState(merchant, "active"));

console.log("-- pause");
const inflight = await openSale(keyA, 100_000n); await inflight.open(); await inflight.fundVault(); // opened and paid BEFORE the pause
const inflight2 = await openSale(keyA, 100_000n); await inflight2.open(); await inflight2.fundVault();
await expectOk("the merchant pauses (the control account is created, the merchant pays its rent)", () => setState(merchant, "paused"));
rec("the control account says Paused", (await ctl()) === "paused");
{ const n = await openSale(keyA, 100_000n); await expectErr("PAUSED: open_sale is refused even with a perfectly valid claim", NOT_ACTIVE, () => n.open()); }
{ const r = await inflight.settle(); rec("a sale opened BEFORE the pause still settles while paused", r.status === "settled" && r.merchant + r.commission + r.fee === 100_000n); }
await expectOk("...and another in-flight sale can still be refunded while paused", async () => {
  const s: any = inflight2; const buyerAta = ata((await (program.account as any).sale.fetch(s.sale)).buyer);
  const ix = await program.methods.refundSale().accounts({ merchant: merchant.publicKey, campaign, sale: s.sale, saleVault: ata(s.sale), buyerAta, rentPayer: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID } as any).instruction();
  await sendAndConfirmTransaction(conn, new Transaction().add(ix), [merchant]);
});
await expectErr("pausing twice is refused", BAD_STATE, () => setState(merchant, "paused"));

console.log("-- resume");
await expectErr("a stranger cannot resume", NOT_MERCHANT, () => setState(rando, "active"));
await expectOk("the merchant resumes", () => setState(merchant, "active"));
await sellsOk("after resuming, new sales open and settle again");

console.log("-- the control account cannot be bypassed or griefed");
{ // someone sends lamports to the control address BEFORE it is ever initialised by a merchant: must not break pausing or selling
  const other = Keypair.generate(), idB = new anchor.BN(crypto.randomBytes(6)), campB = PublicKey.findProgramAddressSync([Buffer.from("campaign"), merchant.publicKey.toBuffer(), idB.toArrayLike(Buffer, "le", 8)], PROGRAM)[0];
  await program.methods.createCampaign(idB, 1500, new anchor.BN(1_000_000), keyA.publicKey, [...Buffer.from(CLUSTER + "\0".repeat(8 - CLUSTER.length))], 0).accounts({ merchant: merchant.publicKey, mint, config: configPda, campaign: campB, systemProgram: SystemProgram.programId } as any).signers([merchant]).rpc();
  const ctlB = PublicKey.findProgramAddressSync([Buffer.from("control"), campB.toBuffer()], PROGRAM)[0];
  await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: rando.publicKey, toPubkey: ctlB, lamports: 1_500_000 })), [rando]);
  await expectOk("a pre-funded (system-owned) control address does not stop the merchant pausing that campaign", () => program.methods.setCampaignState({ paused: {} } as any).accounts({ merchant: merchant.publicKey, campaign: campB, control: ctlB, systemProgram: SystemProgram.programId } as any).signers([merchant]).rpc());
  const c2: any = await (program.account as any).campaignControl.fetch(ctlB); rec("...and it reads Paused", Object.keys(c2.state)[0] === "paused" && c2.campaign.equals(campB));
  // another campaign's control account cannot be passed in place of this one (the address is pinned by seeds): campaign A (active) with campaign B's PAUSED control => seeds error, not a pause
  const n = await openSale(keyA, 100_000n);
  const bad = await program.methods.openSale([...n.nonce], new anchor.BN(n.expiry), new anchor.BN("100000")).accounts({ payer: payer.publicKey, campaign, distributor, buyer: n.buyer.publicKey, mint, sale: n.sale, saleVault: ata(n.sale), instructions: new PublicKey("Sysvar1nstructions1111111111111111111111111"), tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, control: ctlB } as any).instruction();
  await expectErr("a different campaign's control account is rejected by the seeds check", /ConstraintSeeds|seeds constraint/i, () => sendAndConfirmTransaction(conn, new Transaction().add(Ed25519Program.createInstructionWithPrivateKey({ privateKey: keyA.secretKey, message: n.msg }), bad), [payer]));
  void other;
}

console.log("-- permanent end");
await expectOk("pause, then end from Paused", async () => { await setState(merchant, "paused"); await setState(merchant, "ended"); });
rec("the control account says Ended", (await ctl()) === "ended");
{ const n = await openSale(keyA, 100_000n); await expectErr("ENDED: open_sale is refused", NOT_ACTIVE, () => n.open()); }
await expectErr("an ended campaign can never be resumed", BAD_STATE, () => setState(merchant, "active"));
await expectErr("...nor paused", BAD_STATE, () => setState(merchant, "paused"));
await expectErr("...nor ended again", BAD_STATE, () => setState(merchant, "ended"));
rec("after the refusals it is still Ended", (await ctl()) === "ended");
await expectOk("an ended campaign can still be topped up (harmless)", () => program.methods.topUpBudget(new anchor.BN(1)).accounts({ merchant: merchant.publicKey, campaign } as any).signers([merchant]).rpc());
await expectOk("...and its claim key can still be rotated (a leaked key matters most after the end)", () => program.methods.setAttributionKey(keyB.publicKey).accounts({ merchant: merchant.publicKey, campaign } as any).signers([merchant]).rpc());

const failed = results.filter((r) => !r.ok); console.log(`\n${results.length - failed.length}/${results.length} checks passed`); process.exit(failed.length ? 1 : 0);
