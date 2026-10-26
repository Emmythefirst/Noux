/**
 * Devnet end-to-end through the REAL stack: claim-issuance API (Postgres) -> merchant gateway middleware (x402, CDP facilitator)
 * -> on-chain program -> keeper. Real devnet USDC. Run from apps/api:  pnpm devnet-e2e
 */
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto"; import type { AddressInfo } from "node:net";
import express from "express";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, getAccount, transfer } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactSvmScheme as ExactSvmClient } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import pg from "pg";
import { BRAND, LocalKeySigner, OnchainCampaignReader, idl, signClaimRequest, salePda, claimFromWire, type ClaimWire } from "@noux/core";
import { AnchorChain, AnchorKeeperChain, Keeper, createNouxGateway, encodeClaimHeader, type GatewayEvent } from "@noux/gateway";
import { createPool, migrate } from "../src/db";
import { createApp } from "../src/app";
import { PgSeenStore } from "../src/seen-store";

process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
const KEYS = path.resolve(import.meta.dirname, "../../../spike/keys");
const key = (n: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS, `${n}.json`), "utf8"))));
const buyer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const [merchant, distributor, feeOwner, attest, attacker] = ["merchant", "distributor", "fee", "attribution", "attacker"].map(key);

const NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const PROGRAM = new PublicKey((idl as any).address);
const conn = new Connection(process.env.RPC_URL!, "confirmed");
const PRICE = 100_000n, HOLD = 15, COMMISSION_BPS = 1500, FEE_BPS = 100;
const results: { name: string; ok: boolean }[] = [];
const rec = (name: string, ok: boolean, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ata = (o: PublicKey) => getAssociatedTokenAddressSync(USDC, o, true);
// Retry transient RPC trouble; only a genuinely missing account counts as zero (a swallowed error once produced a bogus -979986 delta).
async function withRetry<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 1; ; i++) { try { return await fn(); } catch (e) { if (i >= tries || /could not find account|TokenAccountNotFound|Invalid param/i.test(String((e as Error).name + (e as Error).message))) throw e; await sleep(1500 * i); } }
}
const bal = async (a: PublicKey) => { try { return Number((await withRetry(() => getAccount(conn, a))).amount); } catch (e) { if (/could not find account|TokenAccountNotFound|Invalid param/i.test(String((e as Error).name + (e as Error).message))) return 0; throw e; } };
const snap = async () => ({ m: await bal(ata(merchant.publicKey)), d: await bal(ata(distributor.publicKey)), f: await bal(ata(feeOwner.publicKey)), b: await bal(ata(buyer.publicKey)) });

// ---------- setup: accounts, campaign ----------
for (const o of [merchant, distributor, feeOwner, attacker]) await getOrCreateAssociatedTokenAccount(conn, buyer, USDC, o.publicKey);
for (const o of [merchant, attacker]) if ((await conn.getBalance(o.publicKey)) < 5_000_000) await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: o.publicKey, lamports: 10_000_000 })), [buyer]);
if ((await bal(ata(attacker.publicKey))) < 200_000) await transfer(conn, buyer, ata(buyer.publicKey), ata(attacker.publicKey), buyer, 300_000);

const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(buyer), { commitment: "confirmed" }));
const cid = new anchor.BN(crypto.randomBytes(6));
const [campaign] = PublicKey.findProgramAddressSync([Buffer.from("campaign"), merchant.publicKey.toBuffer(), cid.toArrayLike(Buffer, "le", 8)], PROGRAM);
await program.methods.createCampaign(cid, COMMISSION_BPS, FEE_BPS, new anchor.BN(1_000_000_000), attest.publicKey, [...Buffer.from("devnet\0\0")], HOLD)
  .accounts({ merchant: merchant.publicKey, mint: USDC, feeOwner: feeOwner.publicKey, campaign, systemProgram: SystemProgram.programId }).signers([merchant]).rpc();
console.log("campaign:", campaign.toBase58());

// ---------- claim-issuance API (real Postgres, real chain reader) ----------
const pool = createPool(process.env.DATABASE_URL_TEST ?? "postgres://postgres:devonly@localhost:54329/noux");
await migrate(pool); await pool.query("TRUNCATE claim_issuance, vault_first_seen");
const signer = new LocalKeySigner(attest.secretKey);
const campaigns = new OnchainCampaignReader(conn, PROGRAM, 1_000, 1_000);
const api = createApp({
  pool, signer, campaigns,
  cfg: { CLUSTER: "devnet", PROGRAM_ID: PROGRAM.toBase58(), CLAIM_TTL_SECS: 600, MAX_PRICE_BASE_UNITS: 100_000_000n, LIMIT_PER_DISTRIBUTOR_PER_MIN: 30, LIMIT_PER_BUYER_PER_MIN: 30, LIMIT_PER_CAMPAIGN_PER_MIN: 120, LIMIT_PER_IP_PER_MIN: 60 },
}, { trustProxy: true });
async function getClaim(opts: { buyerKey?: Keypair; price?: bigint; dist?: PublicKey } = {}): Promise<ClaimWire> {
  const b = opts.buyerKey ?? buyer, price = opts.price ?? PRICE, ts = Math.floor(Date.now() / 1000), dist = opts.dist ?? distributor.publicKey;
  const sig = signClaimRequest(b.secretKey, { campaign, distributor: dist, buyer: b.publicKey, price, ts });
  const res = await api.request("/v1/claims", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
    body: JSON.stringify({ campaign: campaign.toBase58(), distributor: dist.toBase58(), buyer: b.publicKey.toBase58(), price: price.toString(), ts, buyerSignature: Buffer.from(sig).toString("base64") }) });
  if (res.status !== 201) throw new Error(`claim request failed ${res.status}: ${await res.text()}`);
  return (await res.json()).claim;
}

// ---------- merchant gateways (real x402, CDP facilitator) ----------
const facilitator = new HTTPFacilitatorClient(createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET));
const chain = new AnchorChain({ connection: conn, programId: PROGRAM, mint: USDC, gatewayPayer: buyer, merchant });
async function startGateway(withSettler: boolean) {
  const events: GatewayEvent[] = [];
  const gw = createNouxGateway({
    programId: PROGRAM, cluster: "devnet", campaign, mint: USDC, network: NET, merchantPayTo: merchant.publicKey, facilitator, connection: conn, campaigns,
    opener: chain, settler: withSettler ? chain : undefined, routes: { "GET /report": { price: PRICE, description: "e2e report" } }, onEvent: (e) => { events.push(e); if (e.type !== "facilitator" && process.env.VERBOSE) console.log("   gw:", JSON.stringify(e)); },
  });
  const app = express(); app.use(gw.middleware); app.get("/report", (_q, r) => r.json({ report: "ok" }));
  const srv = await new Promise<import("node:http").Server>((res) => { const s = app.listen(0, () => res(s)); });
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, events, close: () => new Promise((r) => srv.close(() => r(null))) };
}
const payFetch = async (who: Keypair) => wrapFetchWithPayment(fetch, new x402Client().register("solana:*", new ExactSvmClient(await createKeyPairSignerFromBytes(who.secretKey))));
const call = async (f: typeof fetch, url: string, claim?: ClaimWire) => {
  for (let i = 1; i <= 4; i++) { // gateway->CDP calls can fail at network level ("fetch failed"); ResilientFacilitator retries, but be lenient at the client too
    const r = await f(`${url}/report`, { headers: claim ? { [BRAND.claimHeader]: encodeClaimHeader(claim) } : {} });
    const txt = await r.text(); const ph = r.headers.get("payment-response");
    if (r.status === 200 || i === 4) return { status: r.status, body: txt, tx: ph ? decodePaymentResponseHeader(ph).transaction : undefined, why: r.headers.get("payment-required") ? JSON.parse(Buffer.from(r.headers.get("payment-required")!, "base64").toString()).error : undefined };
    if (!/fetch failed/.test(JSON.stringify({ txt, why: r.headers.get("payment-required") && Buffer.from(r.headers.get("payment-required")!, "base64").toString() }))) return { status: r.status, body: txt, tx: undefined, why: r.headers.get("payment-required") ? JSON.parse(Buffer.from(r.headers.get("payment-required")!, "base64").toString()).error : undefined };
    await sleep(1500);
  }
  throw new Error("unreachable");
};
const FEE = Number(PRICE) * FEE_BPS / 10000, COM = Number(PRICE) * COMMISSION_BPS / 10000, MER = Number(PRICE) - FEE - COM;
const buyerPay = await payFetch(buyer);

// ---------- 1. claim -> gateway -> x402 -> merchant settles after delivery ----------
{
  const gw = await startGateway(true); const w = await getClaim(); const c = claimFromWire(w);
  rec("API issued a claim bound to the buyer, signed by the attribution key", c.buyer.equals(buyer.publicKey) && c.attributionKey.equals(attest.publicKey) && c.price === PRICE);
  const before = await snap();
  const r = await call(buyerPay, gw.url, w);
  await sleep(3000);
  const after = await snap(); const sale = salePda(PROGRAM, campaign, c.nonce);
  const s: any = await (program.account as any).sale.fetch(sale);
  rec("1. paid call WITH claim through the gateway: 200 + resource served", r.status === 200 && r.body.includes("ok"), `status=${r.status} x402 tx=${r.tx}`);
  rec("1. split on-chain: merchant/distributor/fee", after.m - before.m === MER && after.d - before.d === COM && after.f - before.f === FEE, `got ${after.m - before.m}/${after.d - before.d}/${after.f - before.f} want ${MER}/${COM}/${FEE}`);
  rec("1. receipt settled on-chain, buyer bound", "settled" in s.status && s.buyer.equals(buyer.publicKey) && s.distributor.equals(distributor.publicKey), `status=${Object.keys(s.status)[0]}`);
  rec("1. merchant settled right after delivery (settle_after_delivery event)", gw.events.some((e) => e.type === "settle_after_delivery" && e.signature));
  await gw.close();
}

// ---------- 2. price enforcement: a lower-priced (validly signed) claim must not discount the purchase ----------
{
  const gw = await startGateway(true); const w = await getClaim({ price: 1_000n }); // the API signs it; the GATEWAY must refuse it
  const before = await snap(); const r = await call(buyerPay, gw.url, w); await sleep(2500); const after = await snap();
  rec("2. lower-priced claim: gateway rejects it (price_mismatch) and charges the REAL price", gw.events.some((e) => e.type === "claim_rejected" && (e as any).reason === "price_mismatch") && r.status === 200,
    `status=${r.status}, buyer paid ${before.b - after.b} (route price ${PRICE})`);
  rec("2. merchant got the full price, distributor got nothing", after.m - before.m === Number(PRICE) && after.d === before.d, `merchant +${after.m - before.m}, distributor +${after.d - before.d}`);
  await gw.close();
}

// ---------- 3. no claim: plain purchase ----------
{
  const gw = await startGateway(true); const before = await snap(); const r = await call(buyerPay, gw.url); await sleep(2500); const after = await snap();
  rec("3. no claim: plain purchase, merchant paid in full, no sale", r.status === 200 && after.m - before.m === Number(PRICE) && after.d === before.d, `merchant +${after.m - before.m}`);
  await gw.close();
}

// ---------- 4. payer binding with a real attacker wallet ----------
{
  const gw = await startGateway(true); const w = await getClaim(); const c = claimFromWire(w);
  const atk = await payFetch(attacker); const before = await snap();
  let r = { status: 0, why: "" as string | undefined };
  for (let i = 0; i < 4; i++) { const x = await call(atk, gw.url, w); r = { status: x.status, why: x.why }; if (x.why !== "fetch failed") break; await sleep(1500); }
  const sale = salePda(PROGRAM, campaign, c.nonce); const vault = await bal(ata(sale)); const after = await snap();
  rec("4. attacker paying the buyer's claim is refused by payer binding; no money moves", r.status !== 200 && gw.events.some((e) => e.type === "payer_mismatch") && vault === 0 && after.m === before.m, `status=${r.status} why=${r.why} vault=${vault}`);
  await gw.close();
}

// ---------- 5. keeper path: no merchant settle; keeper waits the full hold from first sight, then settles ----------
{
  const gw = await startGateway(false); const w = await getClaim(); const c = claimFromWire(w); const sale = salePda(PROGRAM, campaign, c.nonce);
  const before = await snap(); const r = await call(buyerPay, gw.url, w);
  let funded = 0; for (let i = 0; i < 12 && !funded; i++) { funded = await bal(ata(sale)); if (!funded) await sleep(1500); }
  rec("5. paid via gateway with NO merchant settle: vault funded, sale still open", r.status === 200 && funded === Number(PRICE), `vault=${funded}`);
  // Scoped to THIS run's sale: devnet still holds funded-but-unsettled vaults from earlier runs, which an unscoped keeper would (correctly) also settle.
  const real = new AnchorKeeperChain({ connection: conn, programId: PROGRAM, mint: USDC, payer: buyer });
  const keeper = new Keeper({ chain: { ...real, listOpenSales: async () => (await real.listOpenSales()).filter((x) => x.sale === sale.toBase58()), vaultBalance: (s) => real.vaultBalance(s), settle: (s) => real.settle(s), closeExpired: (s) => real.closeExpired(s) }, seen: new PgSeenStore(pool) });
  const t1 = await keeper.tick(); const firstSeen = await new PgSeenStore(pool).get(sale.toBase58());
  rec("5. keeper first tick: records first-seen, does not settle inside the hold", firstSeen !== null && !t1.settled.includes(sale.toBase58()), `settled=${t1.settled.length} waiting=${t1.waiting}`);
  await sleep((HOLD + 2) * 1000);
  const t2 = await keeper.tick(); await sleep(2500); const after = await snap();
  rec("5. keeper settles after the full hold; correct split", t2.settled.includes(sale.toBase58()) && after.m - before.m === MER && after.d - before.d === COM && after.f - before.f === FEE, `settled=${t2.settled.length} failed=${JSON.stringify(t2.failed)} got ${after.m - before.m}/${after.d - before.d}/${after.f - before.f}`);
  const t3 = await keeper.tick();
  rec("5. keeper is idempotent (third tick settles nothing from this sale)", !t3.settled.includes(sale.toBase58()));
  await gw.close();
}

await pool.end();
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
