import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Keypair } from "@solana/web3.js";
import { createPool, migrate } from "../src/db";
import { syncOnce } from "../src/indexer/sync";
import type { IndexerChain, Snapshot, SaleRow, CampaignRow } from "../src/indexer/chain";

const pool = createPool(process.env.DATABASE_URL_TEST ?? "postgres://postgres:devonly@localhost:54329/noux");
const kp = () => Keypair.generate().publicKey.toBase58();
const NOW = 1_800_000_000;
const camp: CampaignRow = { address: kp(), merchant: kp(), mint: kp(), feeOwner: kp(), attributionKey: kp(), cluster: "devnet", holdSecs: 15, commissionBps: 1500, feeBps: 100, commissionBudget: "1000000000", commissionSpent: "0", settledCount: "0", refundedCount: "0" };
let n = 0;
const sale = (over: Partial<SaleRow> = {}): SaleRow => ({ address: kp(), campaign: camp.address, distributor: kp(), buyer: kp(), rentPayer: kp(), price: "100000", gross: "100000", merchantAmount: "84000", commissionAmount: "15000", feeAmount: "1000", commissionBps: 1500, feeBps: 100, status: "settled", openedAt: NOW - 1000 + n, holdUntil: NOW - 990 + n, expiry: NOW + 600, settledAt: NOW - 500 - n++, vaultAmount: "0", ...over });

class Chain implements IndexerChain {
  sales: SaleRow[] = []; unreadable = new Set<string>(); sigCalls = 0;
  async snapshot(): Promise<Snapshot> { return { slot: 1, campaigns: [{ ...camp }], sales: structuredClone(this.sales) }; }
  async signatures(a: string) { this.sigCalls++; return this.unreadable.has(a) ? [] : [{ signature: "open" + a.slice(0, 12), blockTime: 1, failed: false }, { signature: "settle" + a.slice(0, 12), blockTime: 2, failed: false }]; }
  vaultOf(s: string) { return "vault" + s; }
}
/** counts the SQL statements syncOnce sends for idx_sales rows */
function counting() { const stats = { salesInserts: 0 }; const wrapped: any = Object.create(pool); wrapped.query = pool.query.bind(pool); wrapped.connect = async () => { const c = await pool.connect(); return { query: (q: any, ...a: any[]) => { if (typeof q === "string" && /INSERT INTO idx_sales/.test(q)) stats.salesInserts++; return (c as any).query(q, ...a); }, release: () => c.release() }; }; return { pool: wrapped as typeof pool, stats }; }

beforeAll(async () => { await migrate(pool); });
beforeEach(async () => { await pool.query("TRUNCATE idx_campaigns, idx_sales, listings, idx_state"); n = 0; });
afterAll(async () => { await pool.end(); });

describe("indexer at scale", { timeout: 60_000 }, () => {
  it("transaction links are not blocked by the newest sales that cannot be enriched (no head-of-line blocking)", async () => {
    const ch = new Chain(); ch.sales = Array.from({ length: 30 }, () => sale());
    const newest = [...ch.sales].sort((a, b) => b.settledAt! - a.settledAt!).slice(0, 10).map((s) => s.address);
    newest.forEach((a) => ch.unreadable.add(a)); // e.g. the RPC has no history for them
    for (let i = 0; i < 12; i++) await syncOnce(pool, ch, { enrichLimit: 8 });
    const { rows } = await pool.query("SELECT count(*)::int n FROM idx_sales WHERE open_sig IS NOT NULL");
    expect(rows[0].n).toBe(20); // the 20 readable ones; with the old queue the same 8 unreadable rows were retried forever and this stayed at 0
  });
  it("an unreadable sale is retried with backoff, not on every sync", async () => {
    const ch = new Chain(); ch.sales = [sale()]; ch.unreadable.add(ch.sales[0].address);
    for (let i = 0; i < 6; i++) await syncOnce(pool, ch, { enrichLimit: 8 });
    expect(ch.sigCalls).toBeLessThanOrEqual(2); // first attempt (1 call: it finds nothing), then it waits
  });
  it("the whole backlog is worked off at the configured rate (200 sales, 40 per sync => 5 syncs)", async () => {
    const ch = new Chain(); ch.sales = Array.from({ length: 200 }, () => sale());
    for (let i = 0; i < 5; i++) await syncOnce(pool, ch, { enrichLimit: 40 });
    expect((await pool.query("SELECT count(*)::int n FROM idx_sales WHERE open_sig IS NOT NULL AND settle_sig IS NOT NULL")).rows[0].n).toBe(200);
  });
  it("a steady-state sync rewrites only new and open sales, not every finished receipt (statements, not rows: batched)", async () => {
    const ch = new Chain(); ch.sales = [...Array.from({ length: 1000 }, () => sale()), ...Array.from({ length: 20 }, () => sale({ status: "open", gross: "0", merchantAmount: "0", commissionAmount: "0", feeAmount: "0", settledAt: null, vaultAmount: "100000" }))];
    await syncOnce(pool, ch, { enrichLimit: 0 });
    const c = counting(); await syncOnce(c.pool, ch, { enrichLimit: 0 });
    expect(c.stats.salesInserts).toBeLessThanOrEqual(1); // one batch for the 20 open sales; 1000 final receipts are skipped
    expect((await pool.query("SELECT count(*)::int n FROM idx_sales")).rows[0].n).toBe(1020);
  });
  it("batching keeps every semantic: open->settled flips, final rows immutable, vanished open sales deleted, new sales added", async () => {
    const ch = new Chain(); const a = sale({ status: "open", gross: "0", merchantAmount: "0", commissionAmount: "0", feeAmount: "0", settledAt: null, vaultAmount: "100000" }), b = sale(), gone = sale({ status: "open", gross: "0", merchantAmount: "0", commissionAmount: "0", feeAmount: "0", settledAt: null });
    ch.sales = [a, b, gone]; await syncOnce(pool, ch, { enrichLimit: 0 });
    const fresh = sale(); ch.sales = [{ ...a, status: "settled", gross: "100000", merchantAmount: "84000", commissionAmount: "15000", feeAmount: "1000", settledAt: NOW }, { ...b, gross: "1", merchantAmount: "1", commissionAmount: "0", feeAmount: "0" } /* a stale/forged change to a final row */, fresh];
    await syncOnce(pool, ch, { enrichLimit: 0 });
    const m = new Map((await pool.query("SELECT address, status, gross FROM idx_sales")).rows.map((r) => [r.address, r]));
    expect(m.get(a.address).status).toBe("settled"); expect(m.get(a.address).gross).toBe("100000");
    expect(m.get(b.address).gross).toBe("100000"); // final receipt did not change
    expect(m.has(gone.address)).toBe(false); expect(m.has(fresh.address)).toBe(true); expect(m.size).toBe(3);
  });
  it("an empty or short snapshot never wipes finished receipts", async () => {
    const ch = new Chain(); ch.sales = Array.from({ length: 50 }, () => sale()); await syncOnce(pool, ch, { enrichLimit: 0 });
    ch.sales = []; await syncOnce(pool, ch, { enrichLimit: 0 });
    expect((await pool.query("SELECT count(*)::int n FROM idx_sales")).rows[0].n).toBe(50);
  });
});
