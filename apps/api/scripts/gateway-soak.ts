/**
 * Long run: gateway + claim API + keeper under sustained load on devnet, watching for leaks. Unpaid sales only (test mint, so the hosted keeper cannot
 * interfere and no USDC is spent): claim -> gateway 402 -> open_sale -> expiry -> keeper closes it and the rent comes back.
 *   set -a; . ../../.env; set +a; MINUTES=12 RATE=0.5 NODE_OPTIONS=--expose-gc pnpm tsx scripts/gateway-soak.ts
 */
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto"; import type { AddressInfo } from "node:net";
import express from "express";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { BRAND, configPda, LocalKeySigner, OnchainCampaignReader, idl, signClaimRequest, type ClaimWire } from "@noux/core";
import { AnchorChain, AnchorKeeperChain, Keeper, MemorySeenStore, createNouxGateway, encodeClaimHeader, type GatewayEvent } from "@noux/gateway";
import { createPool, migrate } from "../src/db";
import { createApp } from "../src/app";

process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
const MINUTES = Number(process.env.MINUTES ?? 12), RATE = Number(process.env.RATE ?? 0.5), TTL = 150, TICK = 30;
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const keyd = (n: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../../spike/keys", n + ".json"), "utf8"))));
const merchant = keyd("merchant"), attest = keyd("attribution");
const PROGRAM = new PublicKey((idl as any).address), NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const conn = new Connection(process.env.RPC_URL!, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retry = async <T,>(f: () => Promise<T>) => { for (let i = 0; ; i++) { try { return await f(); } catch (e) { if (i >= 6) throw e; await sleep(2000 * (i + 1)); } } };
const mb = (n: number) => Math.round(n / 1048576);

// a transient network error somewhere in a 12-minute run must be COUNTED and reported, not kill the run (an earlier run died this way at minute 11)
let strays = 0; const strayMsgs = new Map<string, number>();
for (const ev of ["unhandledRejection", "uncaughtException"] as const) process.on(ev, (e: any) => { strays++; const m = String(e?.cause?.code ?? e?.message ?? e).slice(0, 80); strayMsgs.set(m, (strayMsgs.get(m) ?? 0) + 1); });
// 429s are retried silently inside web3.js and only printed: count them
let rpc429 = 0; const origErr = console.error; console.error = (...a: any[]) => { if (/429/.test(String(a[0]))) rpc429++; else origErr(...a); }; const origLog = console.log;
const mint = await createMint(conn, deployer, deployer.publicKey, null, 6);
const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(deployer), { commitment: "confirmed" }));
if ((await conn.getBalance(merchant.publicKey)) < 20_000_000) await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: merchant.publicKey, lamports: 20_000_000 })), [deployer]);
const cid = new anchor.BN(crypto.randomBytes(6));
const [campaign] = PublicKey.findProgramAddressSync([Buffer.from("campaign"), merchant.publicKey.toBuffer(), cid.toArrayLike(Buffer, "le", 8)], PROGRAM);
await program.methods.createCampaign(cid, 1500, new anchor.BN(1_000_000_000), attest.publicKey, [...Buffer.from("devnet\0\0")], 15)
  .accounts({ merchant: merchant.publicKey, mint, config: configPda(PROGRAM), campaign, systemProgram: SystemProgram.programId }).signers([merchant]).rpc();
console.log(`campaign ${campaign.toBase58()} test mint ${mint.toBase58()}; ${MINUTES} min at ${RATE} sales/s, claim TTL ${TTL} s, keeper tick ${TICK} s`);

const pool = createPool(process.env.DATABASE_URL_TEST ?? "postgres://postgres:devonly@localhost:54329/noux"); await migrate(pool); await pool.query("TRUNCATE claim_issuance");
const campaigns = new OnchainCampaignReader(conn, PROGRAM, 15_000, 15_000);
const api = createApp({ pool, signer: new LocalKeySigner(attest.secretKey), campaigns, cfg: { CLUSTER: "devnet", PROGRAM_ID: PROGRAM.toBase58(), CLAIM_TTL_SECS: TTL, MAX_PRICE_BASE_UNITS: 100_000_000n, LIMIT_PER_DISTRIBUTOR_PER_MIN: 1e6, LIMIT_PER_BUYER_PER_MIN: 1e6, LIMIT_PER_CAMPAIGN_PER_MIN: 1e6, LIMIT_PER_IP_PER_MIN: 1e6 } }, { trustProxy: true });
const dists = Array.from({ length: 20 }, () => Keypair.generate().publicKey);
async function claim(): Promise<ClaimWire> {
  const b = Keypair.generate(), dist = dists[Math.floor(Math.random() * dists.length)], ts = Math.floor(Date.now() / 1000);
  const sig = signClaimRequest(b.secretKey, { campaign, distributor: dist, buyer: b.publicKey, price: 10_000n, ts });
  const r = await api.request("/v1/claims", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.11" }, body: JSON.stringify({ campaign: campaign.toBase58(), distributor: dist.toBase58(), buyer: b.publicKey.toBase58(), price: "10000", ts, buyerSignature: Buffer.from(sig).toString("base64") }) });
  if (r.status !== 201) throw new Error("claim " + r.status); return (await r.json()).claim;
}
const chain = new AnchorChain({ connection: conn, programId: PROGRAM, mint, gatewayPayer: deployer });
const events: Record<string, number> = {}; const onEvent = (e: GatewayEvent) => { const k = e.type === "facilitator" ? "facilitator:" + (e.detail as any)?.type : e.type; events[k] = (events[k] ?? 0) + 1; };
const gw = createNouxGateway({ programId: PROGRAM, cluster: "devnet", campaign, mint, network: NET, merchantPayTo: merchant.publicKey, facilitator: new HTTPFacilitatorClient(createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET)), connection: conn, campaigns, opener: chain, routes: { "GET /report": { price: 10_000n } }, onEvent });
const app = express(); app.use(gw.middleware); app.get("/report", (_q, r) => r.json({ ok: true }));
const srv = await new Promise<import("node:http").Server>((res) => { const s = app.listen(0, () => res(s)); });
const URL_ = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/report`;

// ---- keeper (production tick) ----
const keeperChain = new AnchorKeeperChain({ connection: conn, programId: PROGRAM, mint, payer: deployer });
const keeper = new Keeper({ chain: keeperChain, seen: new MemorySeenStore() });
const kt = { ticks: 0, closed: 0, failed: 0, maxMs: 0 }; let keeping = true;
(async () => { while (keeping) { const s = Date.now(); const r = await keeper.tick().catch(() => ({ closed: [] as string[], failed: [{}] as any[] })); kt.ticks++; kt.closed += r.closed.length; kt.failed += r.failed.length; kt.maxMs = Math.max(kt.maxMs, Date.now() - s); await sleep(Math.max(0, TICK * 1000 - (Date.now() - s))); } })();

// ---- event-loop lag ----
let lagMax = 0; const lags: number[] = []; let last = performance.now();
const lagTimer = setInterval(() => { const now = performance.now(); const lag = Math.max(0, now - last - 100); last = now; lagMax = Math.max(lagMax, lag); lags.push(lag); if (lags.length > 20000) lags.shift(); }, 100);

// ---- driver ----
const stat = { sent: 0, ok402: 0, other: 0, errors: 0, lat: [] as number[] }; let driving = true; const inflight = new Set<Promise<void>>();
const solStart = await conn.getBalance(deployer.publicKey), t0 = Date.now();
(async () => { while (driving) {
  const p = (async () => { const s = Date.now(); stat.sent++; try { const c = await claim(); const r = await fetch(URL_, { headers: { [BRAND.claimHeader]: encodeClaimHeader(c) } }); await r.text(); r.status === 402 ? stat.ok402++ : stat.other++; stat.lat.push(Date.now() - s); } catch { stat.errors++; } })();
  inflight.add(p); p.finally(() => inflight.delete(p)); await sleep(1000 / RATE); } })();

// ---- sampler ----
const samples: { t: number; rss: number; heap: number; handles: number; tracked: number; open: number; lockedSol: number; inflight: number }[] = [];
const handles = () => (process as any)._getActiveHandles?.().length ?? 0;
const sample = async () => { try { await sampleInner(); } catch (e) { strays++; } };
const sampleInner = async () => { (globalThis as any).gc?.(); const m = process.memoryUsage(); const open = (await keeperChain.listOpenSales().catch(() => [])).length;
  const s = { t: Math.round((Date.now() - t0) / 1000), rss: mb(m.rss), heap: mb(m.heapUsed), handles: handles(), tracked: gw.trackedSales(), open, lockedSol: (solStart - (await conn.getBalance(deployer.publicKey).catch(() => solStart))) / 1e9, inflight: inflight.size };
  samples.push(s); console.log(`@${String(s.t).padStart(4)}s rss ${s.rss} MB heap ${s.heap} MB handles ${s.handles} tracked ${s.tracked} open ${s.open} locked ${s.lockedSol.toFixed(3)} SOL inflight ${s.inflight} | sent ${stat.sent} 402s ${stat.ok402} other ${stat.other} err ${stat.errors} | lag max ${lagMax.toFixed(0)} ms | 429s ${rpc429} | keeper closed ${kt.closed}`); };
while (Date.now() - t0 < MINUTES * 60_000) { await sleep(30_000); await sample(); }
driving = false; await Promise.allSettled([...inflight]);
console.log(`--- load stopped after ${Math.round((Date.now() - t0) / 1000)} s; waiting for the keeper to close what is left ---`);
const myOpen = async () => (await retry(() => (program.account as any).sale.all([{ memcmp: { offset: 8, bytes: campaign.toBase58() } }]))).filter((a: any) => "open" in a.account.status).length;
let left = await myOpen().catch(() => -1); const dl = Date.now() + 10 * 60_000; while (left > 0 && Date.now() < dl) { await sleep(20_000); left = await myOpen().catch(() => left); await sample(); }
keeping = false; clearInterval(lagTimer);

// ---- report ----
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] ?? 0;
const solEnd = await conn.getBalance(deployer.publicKey);
const loadS = samples.filter((s) => s.t > 120 && s.t <= MINUTES * 60); const half = Math.floor(loadS.length / 2);
const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const heapDrift = loadS.length > 3 ? avg(loadS.slice(half).map((s) => s.heap)) - avg(loadS.slice(0, half).map((s) => s.heap)) : NaN;
const rssDrift = loadS.length > 3 ? avg(loadS.slice(half).map((s) => s.rss)) - avg(loadS.slice(0, half).map((s) => s.rss)) : NaN;
console.log(`\n==== SOAK REPORT ====`);
console.log(`requests: sent ${stat.sent}, answered 402 ${stat.ok402}, other ${stat.other}, errors ${stat.errors}; latency p50=${pct(stat.lat, .5)} p95=${pct(stat.lat, .95)} max=${Math.max(0, ...stat.lat)} ms`);
console.log(`gateway events: ${JSON.stringify(events)}`);
console.log(`memory: heap first-half avg -> second-half avg drift ${heapDrift.toFixed(1)} MB; rss drift ${rssDrift.toFixed(1)} MB; max handles ${Math.max(...samples.map((s) => s.handles))}; tracked sales max ${Math.max(...samples.map((s) => s.tracked))}`);
console.log(`event loop lag: max ${lagMax.toFixed(0)} ms, p99 ${pct(lags, .99).toFixed(0)} ms`);
console.log(`keeper: ${kt.ticks} ticks, closed ${kt.closed}, failed ${kt.failed}, slowest tick ${kt.maxMs} ms; open sales left on chain from this test: ${left}`);
console.log(`stray async errors survived (network blips): ${strays} ${JSON.stringify([...strayMsgs])}`);
console.log(`RPC 429 retries seen: ${rpc429}; payer SOL ${(solStart / 1e9).toFixed(4)} -> ${(solEnd / 1e9).toFixed(4)} (net ${((solEnd - solStart) / 1e9).toFixed(5)}: fees only if everything was closed)`);
srv.close(); await pool.end(); process.exit(left === 0 ? 0 : 1);
