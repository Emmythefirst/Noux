/**
 * Keeper under a real backlog on devnet. Opens K unpaid sales (test mint, so the hosted keeper cannot touch them), lets their claims expire, and watches
 * a keeper with the production tick (30 s) drain them. Unpaid rent is refunded on close, so this costs only transaction fees.
 *   set -a; . ../../.env; set +a; K=120 pnpm tsx scripts/keeper-backlog.ts
 */
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { configPda, LocalKeySigner, OnchainCampaignReader, idl, signClaimRequest, claimFromWire, type ClaimWire } from "@noux/core";
import { AnchorChain, AnchorKeeperChain, Keeper, MemorySeenStore } from "@noux/gateway";
import { createPool, migrate } from "../src/db";
import { createApp } from "../src/app";

process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
const K = Number(process.env.K ?? 120), TTL = Number(process.env.TTL ?? 150), TICK = Number(process.env.TICK ?? 30), CONC = Number(process.env.CONC ?? 8);
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const merchant = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../../spike/keys/merchant.json"), "utf8"))));
const attest = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../../spike/keys/attribution.json"), "utf8"))));
const PROGRAM = new PublicKey((idl as any).address);
const conn = new Connection(process.env.RPC_URL!, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] ?? 0;

const mint = await createMint(conn, deployer, deployer.publicKey, null, 6);
const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(deployer), { commitment: "confirmed" }));
if ((await conn.getBalance(merchant.publicKey)) < 20_000_000) await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: merchant.publicKey, lamports: 20_000_000 })), [deployer]);
const cid = new anchor.BN(crypto.randomBytes(6));
const [campaign] = PublicKey.findProgramAddressSync([Buffer.from("campaign"), merchant.publicKey.toBuffer(), cid.toArrayLike(Buffer, "le", 8)], PROGRAM);
await program.methods.createCampaign(cid, 1500, new anchor.BN(1_000_000_000), attest.publicKey, [...Buffer.from("devnet\0\0")], 15)
  .accounts({ merchant: merchant.publicKey, mint, config: configPda(PROGRAM), campaign, systemProgram: SystemProgram.programId }).signers([merchant]).rpc();
console.log("campaign", campaign.toBase58(), "test mint", mint.toBase58());

const pool = createPool(process.env.DATABASE_URL_TEST ?? "postgres://postgres:devonly@localhost:54329/noux"); await migrate(pool); await pool.query("TRUNCATE claim_issuance");
const api = createApp({ pool, signer: new LocalKeySigner(attest.secretKey), campaigns: new OnchainCampaignReader(conn, PROGRAM, 1_000, 1_000),
  cfg: { CLUSTER: "devnet", PROGRAM_ID: PROGRAM.toBase58(), CLAIM_TTL_SECS: TTL, MAX_PRICE_BASE_UNITS: 100_000_000n, LIMIT_PER_DISTRIBUTOR_PER_MIN: 100_000, LIMIT_PER_BUYER_PER_MIN: 100_000, LIMIT_PER_CAMPAIGN_PER_MIN: 100_000, LIMIT_PER_IP_PER_MIN: 100_000 } }, { trustProxy: true });
const dists = Array.from({ length: 20 }, () => Keypair.generate().publicKey);
async function claim(): Promise<ClaimWire> {
  const b = Keypair.generate(), dist = dists[Math.floor(Math.random() * dists.length)], ts = Math.floor(Date.now() / 1000);
  const sig = signClaimRequest(b.secretKey, { campaign, distributor: dist, buyer: b.publicKey, price: 10_000n, ts });
  const r = await api.request("/v1/claims", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.9" }, body: JSON.stringify({ campaign: campaign.toBase58(), distributor: dist.toBase58(), buyer: b.publicKey.toBase58(), price: "10000", ts, buyerSignature: Buffer.from(sig).toString("base64") }) });
  if (r.status !== 201) throw new Error("claim " + r.status + await r.text()); return (await r.json()).claim;
}
const chain = new AnchorChain({ connection: conn, programId: PROGRAM, mint, gatewayPayer: deployer });
const keeperChain = new AnchorKeeperChain({ connection: conn, programId: PROGRAM, mint, payer: deployer });
const solStart = await conn.getBalance(deployer.publicKey);

// ---- the keeper, production tick, started BEFORE the load so it works while sales are still being opened ----
const ticks: { at: number; ms: number; open: number; closed: number; waiting: number; skipped: number; failed: number }[] = [];
let running = true; const t0 = Date.now();
const mine = new Set<string>();
const keeper = new Keeper({ chain: keeperChain, seen: new MemorySeenStore() });
(async () => { while (running) {
  const s = Date.now(); const open = (await keeperChain.listOpenSales().catch(() => [])).length; const r = await keeper.tick().catch((e) => ({ closed: [] as string[], settled: [] as string[], waiting: 0, skipped: 0, failed: [{ sale: "*", error: String(e) }] }));
  ticks.push({ at: Math.round((Date.now() - t0) / 1000), ms: Date.now() - s, open, closed: r.closed.length, waiting: r.waiting, skipped: r.skipped, failed: r.failed.length });
  const last = ticks[ticks.length - 1]; console.log(`tick @${String(last.at).padStart(4)}s: ${String(last.ms).padStart(6)} ms | open on chain ${last.open} | closed ${last.closed} | skipped ${last.skipped} | failed ${last.failed}${r.failed[0] ? " (" + r.failed[0].error.slice(0, 60) + ")" : ""}`);
  await sleep(TICK * 1000); } })();

// ---- open K unpaid sales at the rate the RPC allows ----
const opened: number[] = []; let next = 0, failedOpens = 0;
const tOpen = Date.now();
await Promise.all(Array.from({ length: CONC }, async () => { while (next < K) { next++; const s = Date.now(); try { const c = claimFromWire(await claim()); await chain.ensureOpen(c); opened.push(Date.now() - s); } catch { failedOpens++; } } }));
console.log(`opened ${opened.length}/${K} unpaid sales in ${Math.round((Date.now() - tOpen) / 1000)} s (${(opened.length / ((Date.now() - tOpen) / 1000)).toFixed(2)}/s); open latency p50=${pct(opened, .5)} p95=${pct(opened, .95)} ms; failed ${failedOpens}`);
console.log(`payer SOL locked in rent right now: ${((solStart - (await conn.getBalance(deployer.publicKey))) / 1e9).toFixed(3)}`);

// ---- wait for the claims to expire and the keeper to drain; our test mint is invisible to the hosted keeper ----
const retry = async <T,>(f: () => Promise<T>) => { for (let i = 0; ; i++) { try { return await f(); } catch (e) { if (i >= 6) throw e; await sleep(2000 * (i + 1)); } } }; // a dropped connection to the RPC must not abort a long run
const myOpen = async () => (await retry(() => (program.account as any).sale.all([{ memcmp: { offset: 8, bytes: campaign.toBase58() } }]))).filter((a: any) => "open" in a.account.status).length;
const deadline = Date.now() + 25 * 60_000; let left = await myOpen();
while (left > 0 && Date.now() < deadline) { await sleep(20_000); left = await myOpen(); }
running = false;
const drained = Math.round((Date.now() - t0) / 1000);
console.log(`\nstill open on chain from this test: ${left} (drained after ${drained} s total)`);
const closedTotal = ticks.reduce((a, t) => a + t.closed, 0), failedTotal = ticks.reduce((a, t) => a + t.failed, 0);
console.log(`ticks ${ticks.length}; closed by the keeper ${closedTotal}; failed ${failedTotal}; slowest tick ${Math.max(...ticks.map((t) => t.ms))} ms (tick interval ${TICK * 1000} ms); most closes in one tick ${Math.max(...ticks.map((t) => t.closed))}`);
const solEnd = await conn.getBalance(deployer.publicKey);
console.log(`payer SOL: ${(solStart / 1e9).toFixed(4)} -> ${(solEnd / 1e9).toFixed(4)} (net ${((solEnd - solStart) / 1e9).toFixed(5)}; only fees should be lost: rent is returned on close)`);
await pool.end(); process.exit(left === 0 ? 0 : 1);
