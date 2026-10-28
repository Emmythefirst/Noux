/**
 * Indexer + public API at scale, with SYNTHETIC snapshots (no chain): the real syncOnce and the real HTTP routes over a real Postgres.
 *   docker exec noux-pg psql -U postgres -c "CREATE DATABASE noux_scale"
 *   SCALE_DB=postgres://postgres:devonly@localhost:54329/noux_scale SIZES=1000,5000,20000,50000 pnpm tsx scripts/indexer-scale.ts
 * Measures our code + Postgres only: RPC cost (getProgramAccounts payload, rate limits) is reported as arithmetic, not measured.
 */
import crypto from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createPool, migrate } from "../src/db";
import { createApp } from "../src/app";
import { syncOnce } from "../src/indexer/sync";
import type { IndexerChain, Snapshot, SaleRow, CampaignRow } from "../src/indexer/chain";
import { LocalKeySigner } from "@noux/core";

const pool = createPool(process.env.SCALE_DB ?? "postgres://postgres:devonly@localhost:54329/noux_scale");
await migrate(pool);
const kp = () => Keypair.generate().publicKey.toBase58();
const NOW = Math.floor(Date.now() / 1000);
const C = 100, D = 500, B = 2000;
const campaigns: CampaignRow[] = Array.from({ length: C }, () => ({ address: kp(), merchant: kp(), mint: kp(), feeOwner: kp(), attributionKey: kp(), cluster: "devnet", holdSecs: 15, commissionBps: 1500, feeBps: 100, commissionBudget: "1000000000", commissionSpent: "0", settledCount: "0", refundedCount: "0" }));
const dists = Array.from({ length: D }, kp), buyers = Array.from({ length: B }, kp);
let counter = 0;
const mkSale = (): SaleRow => {
  const i = counter++, r = i % 20, status = r === 0 ? "refunded" : r === 1 ? "open" : "settled"; const gross = 100_000;
  return { address: kp(), campaign: campaigns[i % C].address, distributor: dists[i % D], buyer: buyers[(i * 7) % B], rentPayer: kp(), price: "100000", gross: status === "open" ? "0" : String(gross), merchantAmount: status === "settled" ? "84000" : "0", commissionAmount: status === "settled" ? "15000" : "0", feeAmount: status === "settled" ? "1000" : "0", commissionBps: 1500, feeBps: 100, status: status as any, openedAt: NOW - 100_000 + i, holdUntil: NOW - 100_000 + i + 15, expiry: NOW + 600, settledAt: status === "open" ? null : NOW - 90_000 + i, vaultAmount: status === "open" ? "100000" : "0" };
};
let sales: SaleRow[] = [];
class Fake implements IndexerChain {
  sigCalls = 0; noSigs = new Set<string>();
  async snapshot(): Promise<Snapshot> { return { slot: 1, campaigns: structuredClone(campaigns), sales: structuredClone(sales) }; }
  async signatures(addr: string) { this.sigCalls++; return this.noSigs.has(addr) ? [] : [{ signature: "o" + addr.slice(0, 20), blockTime: 1, failed: false }, { signature: "s" + addr.slice(0, 20), blockTime: 2, failed: false }]; }
  vaultOf(s: string) { return "v" + s; }
}
const chain = new Fake();
const signer = new LocalKeySigner(Keypair.generate().secretKey);
const app = createApp({ pool, signer, campaigns: { get: async () => null } as any, cfg: { CLUSTER: "devnet", PROGRAM_ID: kp(), CLAIM_TTL_SECS: 600, MAX_PRICE_BASE_UNITS: 1n, LIMIT_PER_DISTRIBUTOR_PER_MIN: 1, LIMIT_PER_BUYER_PER_MIN: 1, LIMIT_PER_CAMPAIGN_PER_MIN: 1, LIMIT_PER_IP_PER_MIN: 1 } },
  { trustProxy: false, clientIp: () => "9.9.9.9", readLimitPerMin: 1_000_000, public: { pool, campaigns: { get: async () => null } as any, cluster: "devnet", programId: kp(), decimals: 6, now: () => NOW } });
const ms = async (f: () => Promise<unknown>) => { const t = performance.now(); await f(); return Math.round(performance.now() - t); };
const get = async (p: string) => { const t = performance.now(); const r = await app.request(p); const b = await r.text(); return { status: r.status, ms: Math.round(performance.now() - t), kb: Math.round(b.length / 1024) }; };

console.log("N       first-sync  steady-sync  steady/1k   payload@RPC   enrich-all-at-8/sync   API ms: campaigns | campaign | stats | receipts p1 | receipts deep | distributor | sales");
for (const n of (process.env.SIZES ?? "1000,5000,20000").split(",").map(Number)) {
  await pool.query("TRUNCATE idx_campaigns, idx_sales, listings, idx_state");
  counter = 0; sales = Array.from({ length: n }, mkSale);
  const first = await ms(() => syncOnce(pool, chain, { enrichLimit: 0 }));
  const steady = await ms(() => syncOnce(pool, chain, { enrichLimit: 0 }));
  const camp = campaigns[0].address, dist = dists[0];
  if (process.env.ANALYZE) await pool.query("ANALYZE idx_sales; ANALYZE idx_campaigns"); // autovacuum does this in production; a bulk load in a benchmark has not had it yet
  await get("/v1/stats"); // warm
  const a = await get("/v1/campaigns?includeUnlisted=1&limit=100"), b = await get(`/v1/campaigns/${camp}`), c = await get("/v1/stats");
  const d = await get("/v1/receipts?limit=20"), e = await get(`/v1/receipts?limit=20&offset=${Math.max(0, n - 40)}`), f = await get(`/v1/distributors/${dist}`), g = await get(`/v1/campaigns/${camp}/sales?limit=100`);
  const payloadMb = (n * 246 / 1e6).toFixed(1);
  console.log(`${String(n).padEnd(7)} ${String(first).padStart(8)}ms ${String(steady).padStart(9)}ms ${String(Math.round(steady / n * 1000)).padStart(8)}ms ${String(payloadMb).padStart(9)} MB ${String(Math.round(n / 8)).padStart(14)} min      ${[a, b, c, d, e, f, g].map((x) => `${x.ms}${x.status !== 200 ? "!" + x.status : ""}`).join(" | ")}`);
}
await pool.end(); process.exit(0);
