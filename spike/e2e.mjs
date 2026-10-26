// Axia devnet e2e. Positive path = REAL x402 payment via x402.org facilitator (real faucet USDC).
// Negative + budget-cap tests call the program directly (budget test funds vaults by plain SPL transfer; labelled).
import fs from "fs"; import os from "os"; import crypto from "crypto"; import express from "express";
import * as anchor from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, Ed25519Program, SYSVAR_INSTRUCTIONS_PUBKEY, sendAndConfirmTransaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, getAccount, transfer, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { ExactSvmScheme as ExactSvmClient } from "@x402/svm/exact/client";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { sweep } from "./sweeper.mjs";

const NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const idl = JSON.parse(fs.readFileSync("../axia/target/idl/axia.json"));
const PROG = new PublicKey(idl.address);
const secret = Uint8Array.from(JSON.parse(fs.readFileSync(os.homedir() + "/.config/solana/id.json")));
const payer = Keypair.fromSecretKey(secret); // also the BUYER and the gateway (rent payer)
const conn = new Connection(process.env.RPC_URL, "confirmed");
const wallet = new anchor.Wallet(payer);
const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);

fs.mkdirSync("keys", { recursive: true });
const loadKey = (n) => { const f = `keys/${n}.json`; if (fs.existsSync(f)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f)))); const k = Keypair.generate(); fs.writeFileSync(f, JSON.stringify([...k.secretKey])); return k; };
const merchant = loadKey("merchant"), distributor = loadKey("distributor"), feeOwner = loadKey("fee"), attest = loadKey("attribution");

const CLUSTER = Buffer.from("devnet\0\0"); // 8-byte cluster tag, signed into every claim
const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };
const bal = async (a) => Number((await getAccount(conn, a)).amount);
const ata = (o) => getAssociatedTokenAddressSync(USDC, o, true);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };

function claimMsg(campaign, dist, buyer, expiry, price, nonce, { program = PROG, cluster = CLUSTER } = {}) {
  return Buffer.concat([Buffer.from("AXIA-CLAIM-v1"), program.toBuffer(), cluster, campaign.toBuffer(), dist.toBuffer(), buyer.toBuffer(), i64(expiry), u64(price), Buffer.from(nonce)]);
}
const salePda = (campaign, nonce) => PublicKey.findProgramAddressSync([Buffer.from("sale"), campaign.toBuffer(), Buffer.from(nonce)], PROG)[0];
const ed25519Ix = (msg, key = attest) => Ed25519Program.createInstructionWithPrivateKey({ privateKey: key.secretKey, message: msg });

async function openSale({ campaign, dist = distributor.publicKey, buyer = payer.publicKey, nonce, expiry, price, signMsg, signer = attest }) {
  const msg = signMsg ?? claimMsg(campaign, dist, buyer, expiry, price, nonce);
  const sale = salePda(campaign, nonce);
  return program.methods.openSale([...nonce], new anchor.BN(expiry), new anchor.BN(price))
    .accounts({ payer: payer.publicKey, campaign, distributor: dist, buyer, mint: USDC, sale, saleVault: ata(sale), instructions: SYSVAR_INSTRUCTIONS_PUBKEY, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .preInstructions([ed25519Ix(msg, signer)]).rpc();
}
async function settle(campaignPk, salePk, distKey = distributor.publicKey, caller = merchant) {
  const c = await program.account.campaign.fetch(campaignPk);
  const pre = createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(distKey), distKey, USDC);
  const m = program.methods.settleSale().accounts({ caller: caller.publicKey, campaign: campaignPk, sale: salePk, saleVault: ata(salePk), merchantAta: ata(c.merchant), distributorAta: ata(distKey), feeAta: ata(c.feeOwner), rentPayer: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID }).preInstructions([pre]);
  return caller.publicKey.equals(payer.publicKey) ? m.rpc() : m.signers([caller]).rpc();
}
async function refund(campaignPk, salePk, signer = merchant) {
  const sale = await program.account.sale.fetch(salePk);
  const pre = createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(sale.buyer), sale.buyer, USDC);
  const m = program.methods.refundSale().accounts({ merchant: signer.publicKey, campaign: campaignPk, sale: salePk, saleVault: ata(salePk), buyerAta: ata(sale.buyer), rentPayer: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID }).preInstructions([pre]);
  return signer.publicKey.equals(payer.publicKey) ? m.rpc() : m.signers([signer]).rpc();
}
async function expectFail(name, fn, needle) {
  try { await fn(); rec(name, false, "unexpectedly succeeded"); }
  catch (e) { const t = (e.message || "") + JSON.stringify(e.logs || e.transactionLogs || ""); rec(name, t.includes(needle), `rejected (${needle}): ${t.match(/Error Message: ([^."]*)/)?.[1] ?? e.message?.slice(0, 120)}`); }
}
async function newCampaign(budget, commissionBps = 1500, feeBps = 100, hold = 0) {
  const id = new anchor.BN(crypto.randomBytes(6));
  const [campaign] = PublicKey.findProgramAddressSync([Buffer.from("campaign"), merchant.publicKey.toBuffer(), id.toArrayLike(Buffer, "le", 8)], PROG);
  await program.methods.createCampaign(id, commissionBps, feeBps, new anchor.BN(budget), attest.publicKey, [...CLUSTER], hold)
    .accounts({ merchant: merchant.publicKey, mint: USDC, feeOwner: feeOwner.publicKey, campaign, systemProgram: SystemProgram.programId }).signers([merchant]).rpc();
  return campaign;
}

// ---- setup ----
if ((await conn.getBalance(merchant.publicKey)) < 20_000_000) await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: merchant.publicKey, lamports: 30_000_000 })), [payer]);
for (const o of [merchant, distributor, feeOwner]) await getOrCreateAssociatedTokenAccount(conn, payer, USDC, o.publicKey);
const buyerAta = ata(payer.publicKey);
const m = { merchant: ata(merchant.publicKey), dist: ata(distributor.publicKey), fee: ata(feeOwner.publicKey) };
const snap = async () => ({ m: await bal(m.merchant), d: await bal(m.dist), f: await bal(m.fee) });
const exp = () => Math.floor(Date.now() / 1000) + 3600;

// ---- gateway with REAL x402 ----
const HOLD = 15; // seconds: anyone-settle is blocked until then; the merchant can settle (or refund) at once
const campaignMain = await newCampaign(1_000_000_000, 1500, 100, HOLD);
console.log("main campaign:", campaignMain.toBase58());
import { createFacilitatorConfig } from "@coinbase/x402";
const FAC = process.env.FACILITATOR === "cdp" ? "cdp" : "x402.org";
console.log("facilitator:", FAC);
const facilitator = new HTTPFacilitatorClient(FAC === "cdp" ? createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET) : { url: "https://x402.org/facilitator" });
const server = new x402ResourceServer(facilitator).register(NET, new ExactSvmScheme());
const claims = new Map(); // claim id -> {nonce, expiry, price, buyer, sale}  (stand-in for the attribution service)
// Claim issuance is where spam is stopped: the attribution key only signs for rate-limited distributors,
// and the gateway only opens (pays rent for) sales that have a valid claim.
const RATE = { max: 5, windowMs: 60_000 }; const issued = new Map();
function issueClaim({ distributorKey = distributor.publicKey, buyer = payer.publicKey, price, ttl = 600 }) {
  const k = distributorKey.toBase58(), now = Date.now();
  const recent = (issued.get(k) ?? []).filter((t) => now - t < RATE.windowMs);
  if (recent.length >= RATE.max) throw new Error("rate limit: too many claims for this distributor");
  issued.set(k, [...recent, now]);
  const nonce = crypto.randomBytes(32), id = crypto.randomUUID();
  const claim = { nonce, expiry: Math.floor(now / 1000) + ttl, price, buyer, distributorKey, sale: salePda(campaignMain, nonce) };
  claims.set(id, claim); return { id, claim };
}
const aborts = []; // sales for which the payer-binding hook aborted
// Payer binding: reject any payment whose verified payer is not the buyer named in the claim.
server.onAfterVerify(async ({ requirements, result }) => {
  if (process.env.DEBUG_HOOK) console.log("HOOK", JSON.stringify({ payTo: requirements.payTo, result }));
  const cl = [...claims.values()].find((c) => c.sale.toBase58() === requirements.payTo);
  if (!cl || result.payer !== cl.buyer.toBase58()) { aborts.push(requirements.payTo); return { abort: true, reason: "payer_mismatch", message: "payer is not the buyer bound to this claim" }; }
});
const payTo = async (ctx) => { // runs on unpaid + paid request: idempotent
  const cl = claims.get(ctx.adapter.getHeader("x-axia-claim"));
  const sale = salePda(campaignMain, cl.nonce);
  if (!(await conn.getAccountInfo(sale))) await openSale({ campaign: campaignMain, dist: cl.distributorKey, buyer: cl.buyer, nonce: cl.nonce, expiry: cl.expiry, price: cl.price });
  return sale.toBase58();
};
const app = express();
app.use(paymentMiddleware({
  "GET /paid": { accepts: [{ scheme: "exact", network: NET, payTo, price: "$0.10" }], description: "axia e2e" },
  "GET /paid-odd": { accepts: [{ scheme: "exact", network: NET, payTo, price: "$0.033333" }], description: "axia e2e rounding" },
}, server));
app.get("/paid", (_q, r) => r.json({ ok: true })); app.get("/paid-odd", (_q, r) => r.json({ ok: true }));
const http = app.listen(4022); await new Promise(r => setTimeout(r, 1500));
const signer = await createKeyPairSignerFromBytes(secret);
const paidFetch = wrapFetchWithPayment(fetch, new x402Client().register("solana:*", new ExactSvmClient(signer)));

async function x402Sale(route, price, label) {
  const { id, claim } = issueClaim({ price }); const nonce = claim.nonce;
  const before = await snap();
  const res = await paidFetch(`http://localhost:4022${route}`, { headers: { "x-axia-claim": id } });
  const body = await res.text();
  const settle402 = res.headers.get("payment-response") ? decodePaymentResponseHeader(res.headers.get("payment-response")) : null;
  const sale = salePda(campaignMain, nonce);
  console.log(`[${label}] x402 status ${res.status} ${body}  x402 tx: ${settle402?.transaction}`);
  let vault = 0; for (let i = 0; i < 10 && !vault; i++) { try { vault = await bal(ata(sale)); } catch {} if (!vault) await new Promise(r => setTimeout(r, 1500)); }
  rec(`${label}: x402 payment landed in per-sale vault`, res.status === 200 && vault === price, `vault=${vault} price=${price}`);
  const sig = await settle(campaignMain, sale);
  const after = await snap();
  const fee = Math.floor(price * 100 / 10000), com = Math.floor(price * 1500 / 10000), mer = price - fee - com;
  const got = { m: after.m - before.m, d: after.d - before.d, f: after.f - before.f };
  rec(`${label}: split correct (merchant/distributor/fee)`, got.m === mer && got.d === com && got.f === fee, `got ${got.m}/${got.d}/${got.f} want ${mer}/${com}/${fee} sum=${got.m + got.d + got.f}/${price}`);
  const s = await program.account.sale.fetch(sale);
  rec(`${label}: receipt stored on-chain`, "settled" in s.status && s.gross.toNumber() === price, `settle tx ${sig}`);
  return { sale, nonce, id };
}
const one = await x402Sale("/paid", 100_000, "A even");
const odd = await x402Sale("/paid-odd", 33_333, "B rounding");

// ---- double settle ----
await expectFail("double settlement rejected", () => settle(campaignMain, one.sale), "");

// ---- negative claims (program-direct) ----
const n1 = crypto.randomBytes(32), e1 = exp();
await expectFail("tampered claim (price changed after signing) rejected", () => openSale({ campaign: campaignMain, nonce: n1, expiry: e1, price: 999_999, signMsg: claimMsg(campaignMain, distributor.publicKey, payer.publicKey, e1, 100_000, n1) }), "ClaimMismatch");
await expectFail("tampered claim (distributor swapped) rejected", () => openSale({ campaign: campaignMain, dist: Keypair.generate().publicKey, nonce: n1, expiry: e1, price: 100_000, signMsg: claimMsg(campaignMain, distributor.publicKey, payer.publicKey, e1, 100_000, n1) }), "ClaimMismatch");
await expectFail("claim signed by wrong key rejected", () => openSale({ campaign: campaignMain, nonce: n1, expiry: e1, price: 100_000, signer: Keypair.generate() }), "WrongSigner");
await expectFail("self-referral (distributor == buyer) rejected", () => openSale({ campaign: campaignMain, dist: payer.publicKey, nonce: n1, expiry: e1, price: 100_000 }), "SelfReferral");
await expectFail("expired claim rejected", () => openSale({ campaign: campaignMain, nonce: n1, expiry: Math.floor(Date.now() / 1000) - 60, price: 100_000 }), "ClaimExpired");
await expectFail("replayed claim (same nonce as settled sale) rejected", () => openSale({ campaign: campaignMain, nonce: one.nonce, expiry: claims.get(one.id).expiry, price: 100_000 }), "already in use");

// ---- underpaid ----
const n2 = crypto.randomBytes(32); await openSale({ campaign: campaignMain, nonce: n2, expiry: exp(), price: 100_000 });
const s2 = salePda(campaignMain, n2);
await transfer(conn, payer, buyerAta, ata(s2), payer, 50_000);
await expectFail("underpaid sale cannot settle", () => settle(campaignMain, s2), "Underpaid");

// ---- budget cap (direct SPL transfers into vaults; NOT x402) ----
const capped = await newCampaign(20_000); // commission budget 0.02 USDC; 15% of 0.10 = 0.015 each
const want = [[15_000], [5_000], [0]];
for (let i = 0; i < 3; i++) {
  const n = crypto.randomBytes(32); await openSale({ campaign: capped, nonce: n, expiry: exp(), price: 100_000 });
  const sv = salePda(capped, n); await transfer(conn, payer, buyerAta, ata(sv), payer, 100_000);
  const b = await snap(); await settle(capped, sv); const a = await snap();
  const d = a.d - b.d, mm = a.m - b.m;
  rec(`budget cap: sale ${i + 1} commission`, d === want[i][0] && mm === 100_000 - 1_000 - d, `distributor +${d} (want ${want[i][0]}), merchant +${mm}`);
}
const cc = await program.account.campaign.fetch(capped);
rec("budget cap: spent never exceeds budget", cc.commissionSpent.toNumber() === 20_000, `spent=${cc.commissionSpent.toNumber()} budget=20000`);

// ================= hardening tests (reviewer items 1-5) =================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);

// -- 5. domain separation: claim signed for another program id / cluster is rejected
const nd = crypto.randomBytes(32), ed = exp();
await expectFail("claim signed for a different cluster (mainnet tag) rejected", () => openSale({ campaign: campaignMain, nonce: nd, expiry: ed, price: 100_000, signMsg: claimMsg(campaignMain, distributor.publicKey, payer.publicKey, ed, 100_000, nd, { cluster: Buffer.from("mainnet\0") }) }), "ClaimMismatch");
await expectFail("claim signed for a different program id rejected", () => openSale({ campaign: campaignMain, nonce: nd, expiry: ed, price: 100_000, signMsg: claimMsg(campaignMain, distributor.publicKey, payer.publicKey, ed, 100_000, nd, { program: Keypair.generate().publicKey }) }), "ClaimMismatch");

// -- 2. payer binding (REAL x402): attacker pays for someone else's claim
const attacker = loadKey("attacker");
await getOrCreateAssociatedTokenAccount(conn, payer, USDC, attacker.publicKey);
if ((await conn.getBalance(attacker.publicKey)) < 2_000_000) await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: attacker.publicKey, lamports: 5_000_000 })), [payer]);
if ((await bal(ata(attacker.publicKey))) < 200_000) await transfer(conn, payer, buyerAta, ata(attacker.publicKey), payer, 200_000);
const atkFetch = wrapFetchWithPayment(fetch, new x402Client().register("solana:*", new ExactSvmClient(await createKeyPairSignerFromBytes(attacker.secretKey))));
const { id: bid, claim: bclaim } = issueClaim({ price: 100_000 });
const atkBefore = await bal(ata(attacker.publicKey));
let atkStatus, atkWhy = "";
for (let attempt = 1; attempt <= 4; attempt++) { // facilitator calls from the gateway can fail at the network level ("fetch failed"): retry those only
  try {
    const ar = await atkFetch("http://localhost:4022/paid", { headers: { "x-axia-claim": bid } }); atkStatus = ar.status;
    const ph = ar.headers.get("payment-required"); const body = await ar.text();
    const why = ph ? JSON.parse(Buffer.from(ph, "base64").toString()).error : "-";
    atkWhy = `attempt ${attempt}: body=${body.slice(0, 120)} required.error=${why}`;
    if (why !== "fetch failed") break;
  } catch (e) { atkStatus = "error: " + e.message?.slice(0, 80); }
  await sleep(1500);
}
await sleep(2500);
const atkAfter = await bal(ata(attacker.publicKey)); let bVault = 0; try { bVault = await bal(ata(bclaim.sale)); } catch {}
rec("payer binding: attacker paying a buyer's claim is refused, no funds move", atkStatus !== 200 && atkAfter === atkBefore && bVault === 0 && aborts.includes(bclaim.sale.toBase58()), `hook aborted=${aborts.includes(bclaim.sale.toBase58())} status=${atkStatus} ${atkWhy} attacker USDC ${atkBefore}->${atkAfter} vault=${bVault}`);
if (process.env.ONLY_PAYER) { console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed (ONLY_PAYER)`); process.exit(0); }
const { id: gid, claim: gclaim } = issueClaim({ price: 100_000 });
const ok = await paidFetch("http://localhost:4022/paid", { headers: { "x-axia-claim": gid } });
rec("payer binding: the bound buyer paying the same kind of claim still works", ok.status === 200, `status=${ok.status}`);

// -- 4. spam cost: rate limit at claim issuance + close_expired_sale returns rent
const spammer = Keypair.generate().publicKey; let issuedN = 0, limited = false;
for (let i = 0; i < 8; i++) { try { issueClaim({ distributorKey: spammer, price: 100_000 }); issuedN++; } catch { limited = true; break; } }
rec("spam: per-distributor claim rate limit kicks in", limited && issuedN === RATE.max, `issued ${issuedN} then limited (max ${RATE.max}/min)`);

const closeIx = (sale) => program.methods.closeExpiredSale().accounts({ sale, saleVault: ata(sale), mint: USDC, campaign: campaignMain, rentPayer: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
const nx = crypto.randomBytes(32), nf = crypto.randomBytes(32), ex = nowS() + 40;
await openSale({ campaign: campaignMain, nonce: nx, expiry: ex, price: 100_000 });
await openSale({ campaign: campaignMain, nonce: nf, expiry: ex, price: 100_000 });
const sx = salePda(campaignMain, nx), sf = salePda(campaignMain, nf);
await transfer(conn, payer, buyerAta, ata(sf), payer, 100_000); // sf gets paid, sx never paid
const timeLeft = ex - nowS();
if (timeLeft < 3) throw new Error(`test setup too slow (only ${timeLeft}s of claim life left): cannot prove close-before-expiry; rerun`);
await expectFail(`close_expired_sale before expiry rejected (${timeLeft}s of claim life left)`, () => closeIx(sx), "NotExpired");
while (nowS() <= ex + 1) await sleep(1000);
await expectFail("close_expired_sale refuses a funded vault (must settle instead)", () => closeIx(sf), "VaultNotEmpty");
const rentBefore = await conn.getBalance(payer.publicKey);
await closeIx(sx);
const gone = !(await conn.getAccountInfo(sx)) && !(await conn.getAccountInfo(ata(sx)));
rec("close_expired_sale: unpaid expired sale closed, rent returned", gone && (await conn.getBalance(payer.publicKey)) > rentBefore - 20_000, `accounts gone=${gone}, payer lamports +${(await conn.getBalance(payer.publicKey)) - rentBefore} (net of tx fee)`);
await expectFail("claim replayed after its sale was closed is rejected (claim expired)", () => openSale({ campaign: campaignMain, nonce: nx, expiry: ex, price: 100_000 }), "ClaimExpired");

// -- 3. settlement sweeper: pay a vault directly (simulates gateway crash after payment), keeper settles it
const nsw = crypto.randomBytes(32); await openSale({ campaign: campaignMain, nonce: nsw, expiry: nowS() + 3600, price: 100_000 });
const ssw = salePda(campaignMain, nsw); await transfer(conn, payer, buyerAta, ata(ssw), payer, 100_000);
const swEarly = await sweep({ program, conn, payer, mint: USDC, only: [ssw] }); // only this sale, right away: its hold is still running
rec("sweeper leaves a funded sale alone while its hold is active", swEarly.settled.length === 0 && swEarly.failed.length === 0 && (await program.account.sale.fetch(ssw)).status.open !== undefined, `settled ${swEarly.settled.length}; still Open, ${((await program.account.sale.fetch(ssw)).holdUntil.toNumber() - nowS())}s of hold left`);
await expectFail("non-merchant settle during hold rejected", () => settle(campaignMain, ssw, distributor.publicKey, payer), "HoldActive");
while (nowS() <= (await program.account.sale.fetch(ssw)).holdUntil.toNumber() + 1) await sleep(1000);
const sw1 = await sweep({ program, conn, payer, mint: USDC, only: [ssw, sf] });
const rcpt = await program.account.sale.fetch(ssw);
rec("sweeper settles funded vaults after the hold (incl. the expired-but-paid one)", sw1.settled.length === 2 && sw1.settled.some((x) => x.sale === ssw.toBase58()) && sw1.settled.some((x) => x.sale === sf.toBase58()) && "settled" in rcpt.status, `settled ${sw1.settled.length}, failed ${sw1.failed.length}`);
const sw2 = await sweep({ program, conn, payer, mint: USDC, only: [ssw, sf] });
rec("sweeper is idempotent (second run settles nothing)", sw2.settled.length === 0 && sw2.failed.length === 0, `second run settled ${sw2.settled.length}, failed ${sw2.failed.length}`);

// -- refund-safe release (REAL x402 payment, then the merchant refunds because "the service failed")
{
  const { id: rid, claim: rc } = issueClaim({ price: 100_000 });
  const mBefore = await snap(), buyBefore = await bal(buyerAta), cBefore = await program.account.campaign.fetch(campaignMain);
  const r = await paidFetch("http://localhost:4022/paid", { headers: { "x-axia-claim": rid } });
  let v = 0; for (let i = 0; i < 10 && !v; i++) { try { v = await bal(ata(rc.sale)); } catch {} if (!v) await sleep(1500); }
  rec("refund: buyer paid via x402 into the sale vault", r.status === 200 && v === 100_000, `status=${r.status} vault=${v}`);
  await expectFail("refund: only the merchant can refund (payer wallet refused)", () => refund(campaignMain, rc.sale, payer), "");
  await expectFail("refund: non-merchant cannot settle inside the hold", () => settle(campaignMain, rc.sale, distributor.publicKey, payer), "HoldActive");
  const sig = await refund(campaignMain, rc.sale);
  const mAfter = await snap(), buyAfter = await bal(buyerAta), s = await program.account.sale.fetch(rc.sale), cAfter = await program.account.campaign.fetch(campaignMain);
  rec("refund: buyer made whole, nobody else paid", buyAfter === buyBefore && mAfter.m === mBefore.m && mAfter.d === mBefore.d && mAfter.f === mBefore.f, `buyer ${buyBefore}->${buyAfter}, merchant/dist/fee unchanged, refund tx ${sig}`);
  rec("refund: receipt shows Refunded, no commission counted", "refunded" in s.status && s.gross.toNumber() === 100_000 && cAfter.commissionSpent.toString() === cBefore.commissionSpent.toString(), `status=${Object.keys(s.status)[0]} commissionSpent unchanged`);
  rec("refund: public counters updated (refund rate = refunded / (settled+refunded))", cAfter.refundedCount.toNumber() === cBefore.refundedCount.toNumber() + 1, `settled=${cAfter.settledCount} refunded=${cAfter.refundedCount}`);
  await expectFail("refund: settling a refunded sale is rejected", () => settle(campaignMain, rc.sale), "");
  await expectFail("refund: refunding twice is rejected", () => refund(campaignMain, rc.sale), "");
  // settled is final
  const nS = crypto.randomBytes(32); await openSale({ campaign: campaignMain, nonce: nS, expiry: nowS() + 3600, price: 100_000 });
  const sS = salePda(campaignMain, nS); await transfer(conn, payer, buyerAta, ata(sS), payer, 100_000);
  await settle(campaignMain, sS);
  await expectFail("refund: after settlement it is final (refund rejected)", () => refund(campaignMain, sS), "");
  // empty vault
  const nE = crypto.randomBytes(32); await openSale({ campaign: campaignMain, nonce: nE, expiry: nowS() + 3600, price: 100_000 });
  await expectFail("refund: empty vault has nothing to refund", () => refund(campaignMain, salePda(campaignMain, nE)), "NothingToRefund");
}

http.close();
console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`); process.exit(results.every(r => r.ok) ? 0 : 1);
