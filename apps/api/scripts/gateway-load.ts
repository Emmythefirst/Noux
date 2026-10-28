/**
 * LOAD test of the gateway through the REAL stack: claim API (Postgres) -> gateway (x402, CDP facilitator, Helius RPC) -> program.
 * N concurrent funded buyers + one claim hammered concurrently. Spends ~0.01 USDC per buyer and ~0.01 SOL per 3 buyers of devnet funds.
 * Run from apps/api:  N=40 pnpm tsx scripts/gateway-load.ts
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
import { BRAND, configPda, LocalKeySigner, OnchainCampaignReader, idl, signClaimRequest, salePda, claimFromWire, type ClaimWire } from "@noux/core";
import { AnchorChain, AnchorKeeperChain, Keeper, createNouxGateway, encodeClaimHeader, type GatewayEvent } from "@noux/gateway";
import { createPool, migrate } from "../src/db";
import { createApp } from "../src/app";
import { PgSeenStore } from "../src/seen-store";

process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
const KEYS = path.resolve(import.meta.dirname, "../../../spike/keys");
const key = (n: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS, `${n}.json`), "utf8"))));
const buyer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const [merchant, distributor, attest, attacker] = ["merchant", "distributor", "attribution", "attacker"].map(key);

const NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const PROGRAM = new PublicKey((idl as any).address);
const conn = new Connection(process.env.RPC_URL!, "confirmed");
const PRICE = 100_000n, HOLD = 15, COMMISSION_BPS = 1500;
// The protocol fee and fee wallet come from the on-chain config, never from the campaign creator.
const protocolCfg = await (new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" })).account as any).config.fetch(configPda(PROGRAM));
const feeOwner = { publicKey: protocolCfg.feeOwner as PublicKey };
const FEE_BPS: number = protocolCfg.feeBps;

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


const N = Number(process.env.N ?? 40), PRICE_L = BigInt(process.env.PRICE ?? 10_000), HAMMER = Number(process.env.HAMMER ?? 30);
const payer = buyer; // the deploy wallet is the gateway payer (pays rent) and funds the buyers
const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(payer), { commitment: "confirmed" }));
for (const o of [merchant, distributor, feeOwner]) await getOrCreateAssociatedTokenAccount(conn, payer, USDC, o.publicKey);
if ((await conn.getBalance(merchant.publicKey)) < 50_000_000) await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: merchant.publicKey, lamports: 50_000_000 })), [payer]);
const cid = new anchor.BN(crypto.randomBytes(6));
const [campaign] = PublicKey.findProgramAddressSync([Buffer.from("campaign"), merchant.publicKey.toBuffer(), cid.toArrayLike(Buffer, "le", 8)], PROGRAM);
await program.methods.createCampaign(cid, COMMISSION_BPS, new anchor.BN(1_000_000_000), attest.publicKey, [...Buffer.from("devnet\0\0")], HOLD)
  .accounts({ merchant: merchant.publicKey, mint: USDC, config: configPda(PROGRAM), campaign, systemProgram: SystemProgram.programId }).signers([merchant]).rpc();
console.log("campaign:", campaign.toBase58());

// ---- buyers: fresh wallets with USDC only (the facilitator pays the network fee) ----
// Refuse to start if the payer cannot fund every buyer, and save the keys BEFORE funding: a run that dies half way must never strand USDC in keys nobody has.
const need = PRICE_L * BigInt(N), have = await bal(ata(payer.publicKey));
if (BigInt(have) < need) { console.error(`not enough devnet USDC: need ${need} base units for ${N} buyers, payer has ${have}`); process.exit(2); }
const buyers = Array.from({ length: N }, () => Keypair.generate());
const keyFile = path.join(os.tmpdir(), `noux-load-buyers-${Date.now()}.json`); fs.writeFileSync(keyFile, JSON.stringify(buyers.map((b) => Array.from(b.secretKey))), { mode: 0o600 });
console.log(`buyer keys saved to ${keyFile} (delete after the run)`);
const { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction } = await import("@solana/spl-token");
for (let i = 0; i < buyers.length; i += 5) {
  const tx = new Transaction(); for (const b of buyers.slice(i, i + 5)) tx.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(b.publicKey), b.publicKey, USDC), createTransferInstruction(ata(payer.publicKey), ata(b.publicKey), payer.publicKey, PRICE_L));
  await sendAndConfirmTransaction(conn, tx, [payer]);
}
console.log(`${N} buyers funded with ${PRICE_L} base units each`);

// ---- claim API ----
const pool = createPool(process.env.DATABASE_URL_TEST ?? "postgres://postgres:devonly@localhost:54329/noux");
await migrate(pool); await pool.query("TRUNCATE claim_issuance, vault_first_seen");
const signer = new LocalKeySigner(attest.secretKey);
const campaigns = new OnchainCampaignReader(conn, PROGRAM, 1_000, 1_000);
const api = createApp({ pool, signer, campaigns, cfg: { CLUSTER: "devnet", PROGRAM_ID: PROGRAM.toBase58(), CLAIM_TTL_SECS: 600, MAX_PRICE_BASE_UNITS: 100_000_000n, LIMIT_PER_DISTRIBUTOR_PER_MIN: 30, LIMIT_PER_BUYER_PER_MIN: 30, LIMIT_PER_CAMPAIGN_PER_MIN: 500, LIMIT_PER_IP_PER_MIN: 500 } }, { trustProxy: true });
const dists = Array.from({ length: 10 }, () => Keypair.generate().publicKey);
async function getClaim(b: Keypair, dist: PublicKey): Promise<ClaimWire> {
  const ts = Math.floor(Date.now() / 1000), sig = signClaimRequest(b.secretKey, { campaign, distributor: dist, buyer: b.publicKey, price: PRICE_L, ts });
  const res = await api.request("/v1/claims", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" }, body: JSON.stringify({ campaign: campaign.toBase58(), distributor: dist.toBase58(), buyer: b.publicKey.toBase58(), price: PRICE_L.toString(), ts, buyerSignature: Buffer.from(sig).toString("base64") }) });
  if (res.status !== 201) throw new Error(`claim request failed ${res.status}: ${await res.text()}`);
  return (await res.json()).claim;
}

// ---- gateway (real CDP facilitator, real chain) ----
const facilitator = new HTTPFacilitatorClient(createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET));
const chain = new AnchorChain({ connection: conn, programId: PROGRAM, mint: USDC, gatewayPayer: payer, merchant });
const events: GatewayEvent[] = [];
// per-stage timing: where does a purchase spend its time?
const stage: Record<string, number[]> = {};
const timed = <T,>(k: string, f: () => Promise<T>) => { const t = Date.now(); const done = () => (stage[k] ??= []).push(Date.now() - t); return f().then((v) => (done(), v), (e) => { done(); throw e; }); };
const timedFac: any = { getSupported: () => facilitator.getSupported(), verify: (...a: any[]) => timed("facilitator.verify", () => (facilitator as any).verify(...a)), settle: (...a: any[]) => timed("facilitator.settle", () => (facilitator as any).settle(...a)) };
const timedOpener = { ensureOpen: (c: any) => timed("open_sale (ensureOpen)", () => chain.ensureOpen(c)) };
const timedSettler = { settle: (c: any) => timed("merchant settle_sale", () => chain.settle(c)), refund: (c: any) => chain.refund(c) };
const gw = createNouxGateway({ programId: PROGRAM, cluster: "devnet", campaign, mint: USDC, network: NET, merchantPayTo: merchant.publicKey, facilitator: timedFac, connection: conn, campaigns, opener: timedOpener, settler: timedSettler, routes: { "GET /report": { price: PRICE_L, description: "load" } }, onEvent: (e) => events.push(e) });
const app = express(); app.use(gw.middleware); app.get("/report", (_q, r) => r.json({ report: "ok" }));
const srv = await new Promise<import("node:http").Server>((res) => { const s = app.listen(0, () => res(s)); });
const URL_ = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/report`;

const payFetch = async (who: Keypair) => wrapFetchWithPayment(fetch, new x402Client().register("solana:*", new ExactSvmClient(await createKeyPairSignerFromBytes(who.secretKey))));
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const solBefore = await conn.getBalance(payer.publicKey), usdcBefore = await bal(ata(payer.publicKey));

// ================= 1. N concurrent funded buyers =================
const claims = await Promise.all(buyers.map((b, i) => getClaim(b, dists[i % dists.length])));
console.log(`${N} claims issued; firing ${N} paid calls at once ...`);
const t0 = Date.now();
const outcomes = await Promise.all(buyers.map(async (b, i) => {
  const f = await payFetch(b); const s = Date.now();
  try {
    const r = await f(URL_, { headers: { [BRAND.claimHeader]: encodeClaimHeader(claims[i]) } });
    const txt = await r.text(); return { i, status: r.status, ms: Date.now() - s, body: txt.slice(0, 120) };
  } catch (e) { return { i, status: -1, ms: Date.now() - s, body: String((e as Error).message).slice(0, 160) }; }
}));
const wall = Date.now() - t0;
const ok = outcomes.filter((o) => o.status === 200), bad = outcomes.filter((o) => o.status !== 200);
console.log(`wall ${wall} ms | 200: ${ok.length}/${N} | other: ${bad.length}`);
console.log(`latency of the 200s ms: p50=${pct(ok.map((o) => o.ms), 0.5)} p95=${pct(ok.map((o) => o.ms), 0.95)} max=${Math.max(0, ...ok.map((o) => o.ms))}`);
const why: Record<string, number> = {}; for (const o of bad) why[`${o.status} ${o.body.replace(/\s+/g, " ").slice(0, 80)}`] = (why[`${o.status} ${o.body.replace(/\s+/g, " ").slice(0, 80)}`] ?? 0) + 1;
if (bad.length) console.log("failures:", JSON.stringify(why));

// wait for the detached settle-after-delivery work
for (let i = 0; i < 120; i++) { const done = events.filter((e) => e.type === "settle_after_delivery" || e.type === "settle_after_delivery_failed").length; if (done >= ok.length) break; await sleep(1000); }
await sleep(3000);
for (const [k, v] of Object.entries(stage)) console.log(`stage ${k.padEnd(24)} n=${String(v.length).padStart(3)} p50=${pct(v, 0.5)} p95=${pct(v, 0.95)} max=${Math.max(...v)} ms`);
const by: Record<string, number> = {}; for (const e of events) { const k = e.type === "facilitator" ? "facilitator:" + (e.detail as any)?.type : e.type; by[k] = (by[k] ?? 0) + 1; } console.log("gateway events:", JSON.stringify(by));

// ---- money-safety invariants, read from the chain ----
let doublePaid = 0, notPaidButServed = 0, paidButNotServed = 0;
for (const o of outcomes) { const left = await bal(ata(buyers[o.i].publicKey)); const spent = Number(PRICE_L) - left;
  if (spent > Number(PRICE_L)) doublePaid++; if (o.status === 200 && spent !== Number(PRICE_L)) notPaidButServed++; if (o.status !== 200 && spent !== 0) paidButNotServed++; }
rec(`no buyer paid twice`, doublePaid === 0, `${doublePaid}`);
rec(`every 200 corresponds to exactly one payment`, notPaidButServed === 0, `${notPaidButServed} served-but-unpaid`);
rec(`no buyer was charged without being served (paid but non-200)`, paidButNotServed === 0, `${paidButNotServed}`);
const mine: any[] = await (program.account as any).sale.all([{ memcmp: { offset: 8, bytes: campaign.toBase58() } }]); // Sale.campaign is the first field; legacy-layout accounts of other campaigns are never decoded
const settled = mine.filter((a) => "settled" in a.account.status), open = mine.filter((a) => "open" in a.account.status);
const exact = settled.every((a) => { const s = a.account; const g = BigInt(s.gross.toString()), m = BigInt(s.merchantAmount.toString()), c = BigInt(s.commissionAmount.toString()), f = BigInt(s.feeAmount.toString()); return m + c + f === g && f === g * BigInt(FEE_BPS) / 10000n && c === g * BigInt(COMMISSION_BPS) / 10000n; });
console.log(`sales on chain for this campaign: ${mine.length} (settled ${settled.length}, still open ${open.length})`);
rec(`one sale per served buyer, no duplicates`, mine.length >= ok.length && new Set(mine.map((a) => Buffer.from(a.account.nonce).toString("hex"))).size === mine.length, `sales ${mine.length} vs 200s ${ok.length}`);
rec(`every settled sale splits exactly (fee ${FEE_BPS} bps, commission ${COMMISSION_BPS} bps, parts sum to gross)`, exact);
rec(`every served buyer's sale was settled by the gateway (none left open)`, open.length === 0 && settled.length === ok.length, `settled ${settled.length}/${ok.length}, open ${open.length}`);

// ================= 2. one claim, many concurrent UNPAID requests (does the open run once on the real chain?) =================
const hb = Keypair.generate(); const hc = await getClaim(hb, dists[0]);
const before = events.length;
const rs = await Promise.all(Array.from({ length: HAMMER }, () => fetch(URL_, { headers: { [BRAND.claimHeader]: encodeClaimHeader(hc) } }).then((r) => r.status).catch(() => -1)));
const hs = salePda(PROGRAM, campaign, Buffer.from(hc.nonce, "hex"));
await sleep(3000);
const sigs = await conn.getSignaturesForAddress(hs, { limit: 50 }, "confirmed");
const payTos = new Set<string>(); const ev = events.slice(before);
console.log(`hammer: ${HAMMER} concurrent requests -> statuses ${JSON.stringify(rs.reduce((a: any, s) => (a[s] = (a[s] ?? 0) + 1, a), {}))}; events ${JSON.stringify(ev.reduce((a: any, e) => (a[e.type] = (a[e.type] ?? 0) + 1, a), {}))}; on-chain transactions touching the sale: ${sigs.length}`);
rec(`same claim x${HAMMER} concurrently: all answered 402 and the sale was opened exactly once`, rs.every((s) => s === 402) && sigs.length === 1 && !ev.some((e) => e.type === "sale_open_failed"), `statuses ok=${rs.every((s) => s === 402)} txs=${sigs.length}`);

const solAfter = await conn.getBalance(payer.publicKey), usdcAfter = await bal(ata(payer.publicKey));
console.log(`gateway payer SOL spent: ${(solBefore - solAfter) / 1e9} for ${mine.length + 1} sales (incl. funding the buyers' ATAs); USDC moved from payer: ${usdcBefore - usdcAfter}`);
const failed = results.filter((r) => !r.ok); console.log(`\n${results.length - failed.length}/${results.length} invariants held; ${ok.length}/${N} buyers served`);
// give the throwaway buyers' empty token accounts back (their rent returns to the payer); buyers that still hold USDC are left alone
if (process.env.CLEANUP !== "0") {
  const { createCloseAccountInstruction } = await import("@solana/spl-token"); let closed = 0;
  const empty: Keypair[] = []; for (const b of buyers) if ((await bal(ata(b.publicKey))) === 0) empty.push(b);
  for (let i = 0; i < empty.length; i += 4) { const grp = empty.slice(i, i + 4); try { await sendAndConfirmTransaction(conn, new Transaction().add(...grp.map((b) => createCloseAccountInstruction(ata(b.publicKey), payer.publicKey, b.publicKey))), [payer, ...grp]); closed += grp.length; } catch (e) { console.log("cleanup batch failed:", String((e as Error).message).slice(0, 80)); } }
  console.log(`closed ${closed}/${buyers.length} buyer token accounts; payer SOL now ${((await conn.getBalance(payer.publicKey)) / 1e9).toFixed(4)}`);
}
await new Promise((r) => srv.close(r)); await pool.end(); process.exit(failed.length ? 1 : 0);
