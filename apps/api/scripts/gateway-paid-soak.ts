/**
 * Real purchases over time + a backlog of FUNDED sales for the keeper, on devnet, real CDP facilitator, real USDC.
 *   Phase 1: P purchases spread over MINUTES (merchant settles in the background); memory/latency/invariants.
 *   Phase 2: B purchases in a burst through a gateway that does NOT settle => B funded open sales; the keeper (production tick) must settle them all.
 * Cost: about 0.01 USDC and 0.0019 SOL per purchase. Needs NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000 on slow links.
 *   set -a; . ../../.env; set +a; P=60 B=60 MINUTES=10 BUYER_RPC=$RPC_URL NODE_OPTIONS="--expose-gc --network-family-autoselection-attempt-timeout=5000" pnpm tsx scripts/gateway-paid-soak.ts
 */
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto"; import type { AddressInfo } from "node:net";
import express from "express";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, getAccount, createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, createCloseAccountInstruction } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme as ExactSvmClient } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { BRAND, configPda, LocalKeySigner, OnchainCampaignReader, idl, signClaimRequest, type ClaimWire } from "@noux/core";
import { AnchorChain, AnchorKeeperChain, Keeper, MemorySeenStore, createNouxGateway, encodeClaimHeader, type GatewayEvent } from "@noux/gateway";
import { createPool, migrate } from "../src/db";
import { createApp } from "../src/app";

process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
const P = Number(process.env.P ?? 60), B = Number(process.env.B ?? 60), MINUTES = Number(process.env.MINUTES ?? 10), PRICE = 10_000n, TICK = 30;
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"), PROGRAM = new PublicKey((idl as any).address), NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const keyd = (n: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../../spike/keys", n + ".json"), "utf8"))));
const merchant = keyd("merchant"), attest = keyd("attribution");
const conn = new Connection(process.env.RPC_URL!, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retry = async <T,>(f: () => Promise<T>) => { for (let i = 0; ; i++) { try { return await f(); } catch (e) { if (i >= 6) throw e; await sleep(2000 * (i + 1)); } } };
const ata = (o: PublicKey) => getAssociatedTokenAddressSync(USDC, o, true);
const bal = async (o: PublicKey) => { try { return (await retry(() => getAccount(conn, ata(o)))).amount; } catch { return 0n; } };
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] ?? 0;
const mb = (n: number) => Math.round(n / 1048576);
const results: { name: string; ok: boolean }[] = [];
const rec = (name: string, ok: boolean, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };
let strays = 0; for (const ev of ["unhandledRejection", "uncaughtException"] as const) process.on(ev, () => { strays++; });

// ---- buyers: refuse to start without the money; save keys BEFORE funding ----
const N = P + B, need = PRICE * BigInt(N);
if ((await bal(deployer.publicKey)) < need) { console.error(`not enough devnet USDC: need ${need}`); process.exit(2); }
const buyers = Array.from({ length: N }, () => Keypair.generate());
const keyFile = path.join(os.tmpdir(), `noux-load-buyers-${Date.now()}.json`); fs.writeFileSync(keyFile, JSON.stringify(buyers.map((b) => Array.from(b.secretKey))), { mode: 0o600 });
console.log(`${N} buyers; keys saved to ${keyFile} (sweep-buyers.ts removes them)`);
for (let i = 0; i < N; i += 5) { const tx = new Transaction(); for (const b of buyers.slice(i, i + 5)) tx.add(createAssociatedTokenAccountIdempotentInstruction(deployer.publicKey, ata(b.publicKey), b.publicKey, USDC), createTransferInstruction(ata(deployer.publicKey), ata(b.publicKey), deployer.publicKey, PRICE)); await retry(() => sendAndConfirmTransaction(conn, tx, [deployer])); }
for (const o of [merchant]) if ((await conn.getBalance(o.publicKey)) < 50_000_000) await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: o.publicKey, lamports: 50_000_000 })), [deployer]);
for (const o of [merchant.publicKey]) await getOrCreateAssociatedTokenAccount(conn, deployer, USDC, o);

// ---- campaign, claim API, two gateways (one settles after delivery, one does not) ----
const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(deployer), { commitment: "confirmed" }));
const cfgAcct: any = await (program.account as any).config.fetch(configPda(PROGRAM)); const FEE_BPS: number = cfgAcct.feeBps, COMMISSION_BPS = 1500;
const cid = new anchor.BN(crypto.randomBytes(6)); const [campaign] = PublicKey.findProgramAddressSync([Buffer.from("campaign"), merchant.publicKey.toBuffer(), cid.toArrayLike(Buffer, "le", 8)], PROGRAM);
await program.methods.createCampaign(cid, COMMISSION_BPS, new anchor.BN(1_000_000_000), attest.publicKey, [...Buffer.from("devnet\0\0")], 15).accounts({ merchant: merchant.publicKey, mint: USDC, config: configPda(PROGRAM), campaign, systemProgram: SystemProgram.programId }).signers([merchant]).rpc();
console.log("campaign", campaign.toBase58());
const pool = createPool(process.env.DATABASE_URL_TEST ?? "postgres://postgres:devonly@localhost:54329/noux"); await migrate(pool); await pool.query("TRUNCATE claim_issuance");
const campaigns = new OnchainCampaignReader(conn, PROGRAM, 15_000, 15_000);
const api = createApp({ pool, signer: new LocalKeySigner(attest.secretKey), campaigns, cfg: { CLUSTER: "devnet", PROGRAM_ID: PROGRAM.toBase58(), CLAIM_TTL_SECS: 600, MAX_PRICE_BASE_UNITS: 100_000_000n, LIMIT_PER_DISTRIBUTOR_PER_MIN: 1e6, LIMIT_PER_BUYER_PER_MIN: 1e6, LIMIT_PER_CAMPAIGN_PER_MIN: 1e6, LIMIT_PER_IP_PER_MIN: 1e6 } }, { trustProxy: true });
const dists = Array.from({ length: 20 }, () => Keypair.generate().publicKey);
async function claim(b: Keypair, attempt = 1): Promise<ClaimWire> {
  const dist = dists[Math.floor(Math.random() * dists.length)], ts = Math.floor(Date.now() / 1000), sig = signClaimRequest(b.secretKey, { campaign, distributor: dist, buyer: b.publicKey, price: PRICE, ts });
  const r = await api.request("/v1/claims", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.12" }, body: JSON.stringify({ campaign: campaign.toBase58(), distributor: dist.toBase58(), buyer: b.publicKey.toBase58(), price: PRICE.toString(), ts, buyerSignature: Buffer.from(sig).toString("base64") }) });
  if (r.status === 503 && attempt < 4) { await sleep(1000 * attempt); return claim(b, attempt + 1); }
  if (r.status !== 201) throw new Error("claim " + r.status); return (await r.json()).claim;
}
const facilitator = new HTTPFacilitatorClient(createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET));
const chain = new AnchorChain({ connection: conn, programId: PROGRAM, mint: USDC, gatewayPayer: deployer, merchant });
const events: Record<string, number> = {}; const onEvent = (e: GatewayEvent) => { if (e.type === "payment_invalid") failCauses.push({ payTo: e.payTo.slice(0, 6), why: e.reason }); if (e.type === "payment_verify_failed" || e.type === "payment_settle_failed") failCauses.push({ payTo: e.payTo.slice(0, 6), why: e.error }); const k = e.type === "facilitator" ? "facilitator:" + (e.detail as any)?.type : e.type; events[k] = (events[k] ?? 0) + 1; };
async function startGateway(settle: boolean) {
  const gw = createNouxGateway({ programId: PROGRAM, cluster: "devnet", campaign, mint: USDC, network: NET, merchantPayTo: merchant.publicKey, facilitator, connection: conn, campaigns, opener: chain, settler: settle ? chain : undefined, routes: { "GET /report": { price: PRICE } }, onEvent });
  const app = express(); app.use(gw.middleware); app.get("/report", (_q, r) => r.json({ ok: true }));
  const srv = await new Promise<import("node:http").Server>((res) => { const s = app.listen(0, () => res(s)); });
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/report`, srv, gw };
}
const failCauses: { payTo: string; why: string }[] = [];
const g1 = await startGateway(true), g2 = await startGateway(false);
const payFetch = async (who: Keypair) => wrapFetchWithPayment(fetch, new x402Client().register("solana:*", new ExactSvmClient(await createKeyPairSignerFromBytes(who.secretKey), process.env.BUYER_RPC ? { rpcUrl: process.env.BUYER_RPC } : undefined)));
async function buy(b: Keypair, url: string) { const s = Date.now(), who = b.publicKey.toBase58(); try { const c = await claim(b); const f = await payFetch(b); const r = await f(url, { headers: { [BRAND.claimHeader]: encodeClaimHeader(c) } }); await r.text(); return { who, status: r.status, ms: Date.now() - s }; } catch (e) { return { who, status: -1, ms: Date.now() - s, err: String((e as Error).message).slice(0, 80) }; } }

// ---- monitoring ----
const samples: { t: number; rss: number; heap: number }[] = []; let lagMax = 0; let last = performance.now();
const lagTimer = setInterval(() => { const n = performance.now(); lagMax = Math.max(lagMax, n - last - 100); last = n; }, 100);
const t0 = Date.now(); const sample = () => { (globalThis as any).gc?.(); const m = process.memoryUsage(); samples.push({ t: Math.round((Date.now() - t0) / 1000), rss: mb(m.rss), heap: mb(m.heapUsed) }); const s = samples[samples.length - 1]; console.log(`@${String(s.t).padStart(4)}s rss ${s.rss} MB heap ${s.heap} MB | lag max ${lagMax.toFixed(0)} ms | strays ${strays}`); };
const mon = setInterval(sample, 30_000);

// ================= Phase 1: paid soak =================
console.log(`\n== Phase 1: ${P} real purchases over ${MINUTES} min (merchant settles after delivery) ==`);
const p1buyers = buyers.slice(0, P), gap = (MINUTES * 60_000) / P, p1: { who: string; status: number; ms: number; err?: string }[] = []; const p1tasks: Promise<void>[] = [];
for (let i = 0; i < P; i++) { p1tasks.push(buy(p1buyers[i], g1.url).then((r) => { p1.push(r); })); await sleep(gap); }
await Promise.all(p1tasks);
const ok1 = p1.filter((r) => r.status === 200); console.log(`phase 1: ${ok1.length}/${P} served; latency p50=${pct(ok1.map((r) => r.ms), .5)} p95=${pct(ok1.map((r) => r.ms), .95)} max=${Math.max(0, ...ok1.map((r) => r.ms))} ms; failures: ${JSON.stringify(p1.filter((r) => r.status !== 200).map((r) => r.err ?? r.status).slice(0, 5))}`);
const notOk = (): string => JSON.stringify(Object.entries(events).filter(([k]) => /payment_|rejected|mismatch|failed/.test(k)));
console.log(`payment problem events so far: ${notOk()}`);
await sleep(45_000); // let the detached merchant settles land

// ================= Phase 2: funded backlog for the keeper =================
console.log(`\n== Phase 2: ${B} purchases in a burst WITHOUT merchant settle => funded open sales for the keeper ==`);
const p2buyers = buyers.slice(P), p2: { who: string; status: number; ms: number }[] = []; let nextB = 0;
await Promise.all(Array.from({ length: 15 }, async () => { while (nextB < p2buyers.length) { const b = p2buyers[nextB++]; p2.push(await buy(b, g2.url)); } }));
const ok2 = p2.filter((r) => r.status === 200); console.log(`phase 2: ${ok2.length}/${B} served in the burst; latency p50=${pct(ok2.map((r) => r.ms), .5)} p95=${pct(ok2.map((r) => r.ms), .95)} ms`);
const mySales = async () => (await retry(() => (program.account as any).sale.all([{ memcmp: { offset: 8, bytes: campaign.toBase58() } }]))) as any[];
const funded = async () => { const open = (await mySales()).filter((a) => "open" in a.account.status); let n = 0; for (const a of open) if ((await bal(a.publicKey)) > 0n) n++; return { open: open.length, funded: n }; };
let st = await funded(); console.log(`backlog right after the burst: ${st.funded} funded open sales (${st.open} open)`);
const keeperChain = new AnchorKeeperChain({ connection: conn, programId: PROGRAM, mint: USDC, payer: deployer });
const keeper = new Keeper({ chain: keeperChain, seen: new MemorySeenStore() }); const tickRows: { at: number; ms: number; settled: number; waiting: number; failed: number }[] = []; const tK = Date.now();
while (st.funded > 0 && Date.now() - tK < 12 * 60_000) {
  const s = Date.now(); const r = await keeper.tick().catch((e) => ({ settled: [] as string[], closed: [] as string[], waiting: 0, skipped: 0, failed: [{ sale: "*", error: String(e) }] }));
  tickRows.push({ at: Math.round((Date.now() - tK) / 1000), ms: Date.now() - s, settled: r.settled.length, waiting: r.waiting, failed: r.failed.length });
  st = await funded(); const t = tickRows[tickRows.length - 1]; console.log(`my keeper tick @${String(t.at).padStart(4)}s: ${String(t.ms).padStart(6)} ms | I settled ${t.settled} | waiting ${t.waiting} | failed ${t.failed} | funded open left ${st.funded}`);
  if (st.funded > 0) await sleep(Math.max(0, TICK * 1000 - (Date.now() - s)));
}
const drained = Math.round((Date.now() - tK) / 1000), mine = tickRows.reduce((a, t) => a + t.settled, 0);
console.log(`backlog drained: ${st.funded === 0} in ${drained} s after the burst; my keeper settled ${mine} of ${ok2.length} (the hosted keeper on Render races for the rest); slowest tick ${Math.max(0, ...tickRows.map((t) => t.ms))} ms`);
clearInterval(mon); clearInterval(lagTimer); sample();

// ================= invariants =================
const all = await mySales(); const settled = all.filter((a) => "settled" in a.account.status), open = all.filter((a) => "open" in a.account.status);
const exact = settled.every((a) => { const s = a.account, g = BigInt(s.gross.toString()), m = BigInt(s.merchantAmount.toString()), c = BigInt(s.commissionAmount.toString()), f = BigInt(s.feeAmount.toString()); return m + c + f === g && f === g * BigInt(FEE_BPS) / 10000n && c === g * BigInt(COMMISSION_BPS) / 10000n; });
let doublePaid = 0, servedUnpaid = 0; const byKey = new Map(buyers.map((b) => [b.publicKey.toBase58(), b])); const allRes = [...p1, ...p2].map((r) => ({ r, b: byKey.get(r.who)! }));
for (const { r, b } of allRes) { const spent = PRICE - (await bal(b.publicKey)); if (spent > PRICE) doublePaid++; if (r.status === 200 && spent !== PRICE) servedUnpaid++; }
rec("no buyer paid twice", doublePaid === 0, `${doublePaid}`); rec("every 200 corresponds to exactly one payment", servedUnpaid === 0, `${servedUnpaid}`);
rec("every settled sale splits exactly (fee, commission, parts sum)", exact, `${settled.length} settled`);
rec("no sale left holding a payment unsettled", st.funded === 0, `open ${open.length}, funded ${st.funded}`);
rec("phase 1 served every buyer", ok1.length === P, `${ok1.length}/${P}`); rec("phase 2 served every buyer", ok2.length === B, `${ok2.length}/${B}`);
const loadS = samples.filter((s) => s.t > 120); const half = Math.floor(loadS.length / 2), avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
console.log(`\n==== PAID SOAK REPORT ====\nsettled ${settled.length}/${ok1.length + ok2.length} served; gateway events ${JSON.stringify(events)}; failure causes: ${JSON.stringify(failCauses)}\nheap drift (first half -> second half) ${(avg(loadS.slice(half).map((s) => s.heap)) - avg(loadS.slice(0, half).map((s) => s.heap))).toFixed(1)} MB, rss ${samples[0]?.rss} -> ${samples[samples.length - 1]?.rss} MB; lag max ${lagMax.toFixed(0)} ms; strays ${strays}`);

// ---- give the throwaway buyers' empty token accounts back ----
let closed = 0; for (let i = 0; i < buyers.length; i += 4) { const grp: Keypair[] = []; for (const b of buyers.slice(i, i + 4)) if ((await bal(b.publicKey)) === 0n) grp.push(b); if (!grp.length) continue; try { await sendAndConfirmTransaction(conn, new Transaction().add(...grp.map((b) => createCloseAccountInstruction(ata(b.publicKey), deployer.publicKey, b.publicKey))), [deployer, ...grp]); closed += grp.length; } catch { /* sweep-buyers.ts finishes the job */ } }
console.log(`closed ${closed}/${buyers.length} buyer token accounts; payer SOL ${((await conn.getBalance(deployer.publicKey)) / 1e9).toFixed(4)}`);
const failed = results.filter((r) => !r.ok); console.log(`${results.length - failed.length}/${results.length} invariants held`);
g1.srv.close(); g2.srv.close(); await pool.end(); process.exit(failed.length ? 1 : 0);
