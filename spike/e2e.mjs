// Axia devnet e2e. Positive path = REAL x402 payment via x402.org facilitator (real faucet USDC).
// Negative + budget-cap tests call the program directly (budget test funds vaults by plain SPL transfer; labelled).
import fs from "fs"; import os from "os"; import crypto from "crypto"; import express from "express";
import * as anchor from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, Ed25519Program, SYSVAR_INSTRUCTIONS_PUBKEY, sendAndConfirmTransaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, getAccount, transfer, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { ExactSvmScheme as ExactSvmClient } from "@x402/svm/exact/client";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { createKeyPairSignerFromBytes } from "@solana/kit";

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

const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };
const bal = async (a) => Number((await getAccount(conn, a)).amount);
const ata = (o) => getAssociatedTokenAddressSync(USDC, o, true);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };

function claimMsg(campaign, dist, buyer, expiry, price, nonce) {
  return Buffer.concat([campaign.toBuffer(), dist.toBuffer(), buyer.toBuffer(), i64(expiry), u64(price), Buffer.from(nonce)]);
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
async function settle(campaignPk, salePk, distKey = distributor.publicKey) {
  const c = await program.account.campaign.fetch(campaignPk);
  return program.methods.settleSale().accounts({ campaign: campaignPk, sale: salePk, saleVault: ata(salePk), merchantAta: ata(c.merchant), distributorAta: ata(distKey), feeAta: ata(c.feeOwner), rentPayer: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
}
async function expectFail(name, fn, needle) {
  try { await fn(); rec(name, false, "unexpectedly succeeded"); }
  catch (e) { const t = (e.message || "") + JSON.stringify(e.logs || e.transactionLogs || ""); rec(name, t.includes(needle), `rejected (${needle}): ${t.match(/Error Message: ([^."]*)/)?.[1] ?? e.message?.slice(0, 120)}`); }
}
async function newCampaign(budget, commissionBps = 1500, feeBps = 100) {
  const id = new anchor.BN(crypto.randomBytes(6));
  const [campaign] = PublicKey.findProgramAddressSync([Buffer.from("campaign"), merchant.publicKey.toBuffer(), id.toArrayLike(Buffer, "le", 8)], PROG);
  await program.methods.createCampaign(id, commissionBps, feeBps, new anchor.BN(budget), attest.publicKey)
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
const campaignMain = await newCampaign(1_000_000_000);
console.log("main campaign:", campaignMain.toBase58());
const facilitator = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });
const server = new x402ResourceServer(facilitator).register(NET, new ExactSvmScheme());
const claims = new Map(); // claim id -> {nonce, expiry, price, sig}  (stand-in for attribution service)
const payTo = async (ctx) => { // runs on unpaid + paid request: idempotent
  const cl = claims.get(ctx.adapter.getHeader("x-axia-claim"));
  const sale = salePda(campaignMain, cl.nonce);
  if (!(await conn.getAccountInfo(sale))) await openSale({ campaign: campaignMain, nonce: cl.nonce, expiry: cl.expiry, price: cl.price });
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
  const nonce = crypto.randomBytes(32); const id = crypto.randomUUID();
  claims.set(id, { nonce, expiry: exp(), price });
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

http.close();
console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`); process.exit(results.every(r => r.ok) ? 0 : 1);
