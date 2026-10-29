import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Keypair } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { createPool, migrate } from "../src/db";
import { syncAuto, syncOnce } from "../src/indexer/sync";
import type { IndexerChain, Snapshot, SaleRow, CampaignRow, TxKeys } from "../src/indexer/chain";

const pool = createPool(process.env.DATABASE_URL_TEST ?? "postgres://postgres:devonly@localhost:54329/noux");
const det = (seed: string) => Keypair.fromSeed(createHash("sha256").update(seed).digest()).publicKey.toBase58();

/** Small deterministic generator so a failing seed can be replayed. */
class Rng { constructor(private s: number) {} next() { this.s = (this.s * 1664525 + 1013904223) >>> 0; return this.s / 2 ** 32; } int(n: number) { return Math.floor(this.next() * n); } pick<T>(a: T[]): T { return a[this.int(a.length)]; } }

/** A simulated chain: accounts change by operations; only SOME operations are program transactions (a payment into a vault is not). */
class World {
  t = 1_800_000_000; seq = 0; rng: Rng; n = 0; kp = () => det(`${this.seed}:${this.n++}`);
  campaigns = new Map<string, CampaignRow>(); sales = new Map<string, SaleRow>(); vault = new Map<string, bigint>(); closed = new Set<string>();
  txs: TxKeys[] = [];
  stats = { campaignReads: 0, saleAccountsRead: 0, txBodiesRead: 0, snapshots: 0 };
  failIncremental = false; overflow = false; lateProb = 0; held: TxKeys[] = [];
  constructor(readonly seed: number, readonly price = 100_000n) { this.rng = new Rng(seed); }
  private tx(keys: string[]) { const e = { signature: "sig" + String(this.seq++).padStart(6, "0"), blockTime: this.t, keys: [...keys, this.kp(), this.kp()] /* noise: wallets, mints, programs */ }; if (this.lateProb > 0 && this.rng.next() < this.lateProb) this.held.push(e); else this.txs.push(e); }
  /** transactions the node indexes late show up now, in their ORIGINAL position (before everything newer) */
  releaseLate(at: number) { if (this.held.length) { this.txs.splice(at, 0, ...this.held); this.held = []; } }
  newCampaign() { const a = this.kp(); this.campaigns.set(a, { address: a, merchant: this.kp(), mint: this.kp(), feeOwner: this.kp(), attributionKey: this.kp(), cluster: "devnet", holdSecs: 15, commissionBps: 1500, feeBps: 100, commissionBudget: "1000000000", commissionSpent: "0", settledCount: "0", refundedCount: "0", state: "active" }); this.tx([a]); }
  open() { const c = this.rng.pick([...this.campaigns.keys()]); const a = this.kp();
    this.sales.set(a, { address: a, campaign: c, distributor: this.kp(), buyer: this.kp(), rentPayer: this.kp(), price: this.price.toString(), gross: "0", merchantAmount: "0", commissionAmount: "0", feeAmount: "0", commissionBps: 1500, feeBps: 100, status: "open", openedAt: this.t, holdUntil: this.t + 15, expiry: this.t + 600, settledAt: null, vaultAmount: "0" });
    this.vault.set(a, 0n); this.tx([a, c]); }
  private open_() { return [...this.sales.values()].filter((s) => s.status === "open"); }
  fund() { const s = this.rng.pick(this.open_()); if (s) this.vault.set(s.address, this.price); /* NO program transaction */ }
  settle() { const s = this.rng.pick(this.open_().filter((x) => (this.vault.get(x.address) ?? 0n) >= this.price)); if (!s) return;
    const g = this.vault.get(s.address)!, fee = g / 100n, com = g * 15n / 100n; this.vault.set(s.address, 0n);
    Object.assign(s, { status: "settled", gross: String(g), merchantAmount: String(g - fee - com), commissionAmount: String(com), feeAmount: String(fee), settledAt: this.t });
    const c = this.campaigns.get(s.campaign)!; c.settledCount = String(BigInt(c.settledCount) + 1n); c.commissionSpent = String(BigInt(c.commissionSpent) + com); this.tx([s.address, s.campaign]); }
  refund() { const s = this.rng.pick(this.open_().filter((x) => (this.vault.get(x.address) ?? 0n) > 0n)); if (!s) return;
    const g = this.vault.get(s.address)!; this.vault.set(s.address, 0n); Object.assign(s, { status: "refunded", gross: String(g), settledAt: this.t });
    const c = this.campaigns.get(s.campaign)!; c.refundedCount = String(BigInt(c.refundedCount) + 1n); this.tx([s.address, s.campaign]); }
  close() { const s = this.rng.pick(this.open_().filter((x) => (this.vault.get(x.address) ?? 0n) === 0n)); if (!s) return; this.sales.delete(s.address); this.closed.add(s.address); this.tx([s.address]); }
  /** open and settle inside ONE interval: an incremental pass never sees this sale open */
  openAndSettle() { this.open(); const last = [...this.sales.keys()].pop()!; this.vault.set(last, this.price); const s = this.sales.get(last)!;
    const g = this.price, fee = g / 100n, com = g * 15n / 100n; this.vault.set(last, 0n); Object.assign(s, { status: "settled", gross: String(g), merchantAmount: String(g - fee - com), commissionAmount: String(com), feeAmount: String(fee), settledAt: this.t });
    const c = this.campaigns.get(s.campaign)!; c.settledCount = String(BigInt(c.settledCount) + 1n); c.commissionSpent = String(BigInt(c.commissionSpent) + com); this.tx([last, s.campaign]); }
  step() { const r = this.rng.int(100);
    if (r < 6) this.newCampaign(); else if (r < 40) this.open(); else if (r < 55) this.fund(); else if (r < 70) this.settle(); else if (r < 77) this.refund(); else if (r < 85) this.close(); else if (r < 95) this.openAndSettle(); /* else: nothing happens */ }
  rowOf(s: SaleRow): SaleRow { return { ...s, vaultAmount: s.status === "open" ? String(this.vault.get(s.address) ?? 0n) : "0" }; }
  chain(): IndexerChain {
    const w = this;
    return {
      async snapshot(): Promise<Snapshot> { w.stats.snapshots++; return { slot: w.seq, campaigns: structuredClone([...w.campaigns.values()]), sales: [...w.sales.values()].map((s) => structuredClone(w.rowOf(s))) }; },
      async signatures() { return []; }, vaultOf: (s) => "v" + s,
      incremental: {
        slot: async () => w.seq,
        head: async () => (w.txs.length ? w.txs[w.txs.length - 1].signature : null),
        txsSince: async (cursor) => { if (w.failIncremental) throw new Error("rpc down"); if (w.overflow) return { txs: [], overflow: true };
          const i = w.txs.findIndex((x) => x.signature === cursor); if (i < 0 && w.txs.length) throw new Error("cursor not found"); const out = w.txs.slice(i + 1); w.stats.txBodiesRead += out.length; return { txs: structuredClone(out), overflow: false }; },
        campaigns: async () => { w.stats.campaignReads++; return structuredClone([...w.campaigns.values()]); },
        sales: async (addresses) => { const sales: SaleRow[] = [], missing: string[] = [];
          for (const a of addresses) { const s = w.sales.get(a); if (s) { w.stats.saleAccountsRead++; sales.push(structuredClone(w.rowOf(s))); } else if (!w.campaigns.has(a)) missing.push(a); /* anything else (wallets, mints) just is not a sale; unknown keys report as missing like real nonexistent accounts */ }
          return { sales, missing }; },
      },
    };
  }
}

const dump = async () => ({
  sales: (await pool.query("SELECT address, campaign, status, gross::text, merchant_amount::text m, commission_amount::text c, fee_amount::text f, vault_amount::text v, extract(epoch FROM settled_at)::bigint s FROM idx_sales ORDER BY address")).rows,
  campaigns: (await pool.query("SELECT address, settled_count::text sc, refunded_count::text rc, commission_spent::text cs FROM idx_campaigns ORDER BY address")).rows,
});
async function run(seed: number, steps: number, mode: "incremental" | "full", perStep = 6, lateProb = 0) {
  await pool.query("TRUNCATE idx_campaigns, idx_sales, listings, idx_state");
  const w = new World(seed); for (let i = 0; i < 3; i++) w.newCampaign(); w.lateProb = lateProb;
  const ch = w.chain(), dumps: any[] = []; let prevBase = 0;
  for (let i = 0; i < steps; i++) {
    const base = w.txs.length; const lateBefore = w.held; w.held = [];
    for (let k = 0; k < 1 + w.rng.int(perStep); k++) w.step();
    if (lateBefore.length) w.txs.splice(prevBase, 0, ...lateBefore); // a late transaction belongs to the PREVIOUS step: it lands before that step's already-visible ones
    prevBase = base + lateBefore.length; // landing the previous step's late transactions shifted this step's group right by their count
    w.t += 30;
    if (mode === "incremental") await syncAuto(pool, ch, { enrichLimit: 0, now: () => w.t }); else await syncOnce(pool, ch, { enrichLimit: 0 });
    dumps.push(await dump());
  }
  return { dumps, w };
}

beforeAll(async () => { await migrate(pool); });
beforeEach(async () => { await pool.query("TRUNCATE idx_campaigns, idx_sales, listings, idx_state"); });
afterAll(async () => { await pool.end(); });

describe("incremental sync is equivalent to a full snapshot", { timeout: 120_000 }, () => {
  for (const seed of [1, 2, 3, 7, 42, 2026]) {
    it(`seed ${seed}: identical tables after every one of 40 steps (opens, payments with no program tx, settles, refunds, closes, open+settle inside one interval)`, async () => {
      const inc = await run(seed, 40, "incremental"); const full = await run(seed, 40, "full");
      expect(inc.dumps.length).toBe(40);
      for (let i = 0; i < 40; i++) expect(inc.dumps[i], `step ${i}`).toEqual(full.dumps[i]);
      expect(inc.dumps[39].sales.length).toBeGreaterThan(20); // the scenario did something
      expect(inc.w.stats.snapshots).toBe(1); // ONE full snapshot (the first pass); every later pass was a delta
    });
  }
  for (const seed of [4, 5, 6]) {
    it(`seed ${seed}, 30% of transactions indexed one step late: after the delay the tables are identical (the safety window re-reads recent transactions)`, async () => {
      const settle = async (mode: "incremental" | "full") => { // 3 quiet passes at the end so every late transaction has landed
        const r = await run(seed, 30, mode, 6, 0.3); const ch = r.w.chain(); r.w.releaseLate(r.w.txs.length);
        for (let i = 0; i < 3; i++) { r.w.t += 30; if (mode === "incremental") await syncAuto(pool, ch, { enrichLimit: 0, now: () => r.w.t }); else await syncOnce(pool, ch, { enrichLimit: 0 }); }
        return dump();
      };
      const inc = await settle("incremental"), full = await settle("full");
      expect(inc).toEqual(full); expect(inc.sales.length).toBeGreaterThan(15);
    });
  }
  it("a quiet chain costs almost nothing: no transactions and no open sales => no sale account is downloaded", async () => {
    await pool.query("TRUNCATE idx_campaigns, idx_sales, listings, idx_state");
    const w = new World(5); w.newCampaign(); for (let i = 0; i < 30; i++) { w.open(); w.fund(); w.settle(); }
    for (const s of [...w.sales.values()]) if (s.status === "open") { w.vault.set(s.address, w.price); const g = w.price; Object.assign(s, { status: "settled", gross: String(g), settledAt: w.t }); } // everything finished
    const ch = w.chain(); await syncAuto(pool, ch, { enrichLimit: 0, now: () => w.t }); // first pass: full
    w.t += 600; w.stats.saleAccountsRead = 0; w.stats.snapshots = 0; w.stats.txBodiesRead = 0;
    for (let i = 0; i < 5; i++) { w.t += 60; await syncAuto(pool, ch, { enrichLimit: 0, now: () => w.t }); }
    expect(w.stats.snapshots).toBe(0); expect(w.stats.saleAccountsRead).toBe(0);
  });
  it("a payment into an open vault (NO program transaction) is still picked up", async () => {
    const w = new World(9); w.newCampaign(); w.open(); const a = [...w.sales.keys()][0]; const ch = w.chain();
    await syncAuto(pool, ch, { enrichLimit: 0, now: () => w.t }); w.t += 100;
    expect((await pool.query("SELECT vault_amount::text v FROM idx_sales WHERE address=$1", [a])).rows[0].v).toBe("0");
    w.vault.set(a, w.price); await syncAuto(pool, ch, { enrichLimit: 0, now: () => w.t });
    expect((await pool.query("SELECT vault_amount::text v FROM idx_sales WHERE address=$1", [a])).rows[0].v).toBe(String(w.price));
  });
  it("a sale that opened and settled between two passes is indexed (it is only ever seen through its transactions)", async () => {
    const w = new World(11); w.newCampaign(); w.open(); const ch = w.chain();
    await syncAuto(pool, ch, { enrichLimit: 0, now: () => w.t }); w.t += 100;
    w.openAndSettle(); w.openAndSettle(); await syncAuto(pool, ch, { enrichLimit: 0, now: () => w.t });
    expect((await pool.query("SELECT count(*)::int n FROM idx_sales WHERE status='settled'")).rows[0].n).toBe(2);
  });
  it("too many new transactions (overflow) falls back to a full snapshot and still ends identical", async () => {
    const w = new World(13); for (let i = 0; i < 3; i++) w.newCampaign(); for (let i = 0; i < 30; i++) w.step(); const ch = w.chain();
    await syncAuto(pool, ch, { enrichLimit: 0, now: () => w.t }); w.t += 100; for (let i = 0; i < 20; i++) w.step();
    w.overflow = true; const before = w.stats.snapshots; const r = await syncAuto(pool, ch, { enrichLimit: 0, now: () => w.t });
    expect(r.mode).toBe("full"); expect(w.stats.snapshots).toBe(before + 1);
    const inc = await dump(); await pool.query("TRUNCATE idx_campaigns, idx_sales, idx_state"); await syncOnce(pool, ch, { enrichLimit: 0 }); expect(inc).toEqual(await dump());
  });
  it("an RPC error during the delta falls back to a full snapshot instead of failing the pass", async () => {
    const w = new World(17); for (let i = 0; i < 3; i++) w.newCampaign(); for (let i = 0; i < 20; i++) w.step(); const ch = w.chain();
    await syncAuto(pool, ch, { enrichLimit: 0, now: () => w.t }); w.t += 100; for (let i = 0; i < 10; i++) w.step();
    w.failIncremental = true; const r = await syncAuto(pool, ch, { enrichLimit: 0, now: () => w.t });
    expect(r.mode).toBe("full");
  });
  it("a full snapshot is forced after fullEverySecs, whatever the delta says", async () => {
    const w = new World(19); w.newCampaign(); w.open(); const ch = w.chain();
    await syncAuto(pool, ch, { enrichLimit: 0, now: () => w.t }); const s0 = w.stats.snapshots;
    w.t += 100; await syncAuto(pool, ch, { enrichLimit: 0, now: () => w.t, fullEverySecs: 3600 }); expect(w.stats.snapshots).toBe(s0);
    w.t += 4000; await syncAuto(pool, ch, { enrichLimit: 0, now: () => w.t, fullEverySecs: 3600 }); expect(w.stats.snapshots).toBe(s0 + 1);
  });
  it("the cursor holds back by the safety window: a transaction a node indexes late (within 90 s) is not skipped", async () => {
    const w = new World(23); w.newCampaign(); const ch = w.chain();
    await syncAuto(pool, ch, { enrichLimit: 0, now: () => w.t }); // full: cursor = the campaign tx
    w.t += 10; w.open(); const a = [...w.sales.keys()][0]; await syncAuto(pool, ch, { enrichLimit: 0, now: () => w.t }); // recent tx (10 s old): cursor must NOT move past it
    const cursor = (await pool.query("SELECT cursor_sig FROM idx_state")).rows[0].cursor_sig; expect(cursor).toBe(w.txs[0].signature);
    expect((await pool.query("SELECT 1 FROM idx_sales WHERE address=$1", [a])).rowCount).toBe(1);
    w.t += 200; await syncAuto(pool, ch, { enrichLimit: 0, now: () => w.t }); // now old enough: it advances
    expect((await pool.query("SELECT cursor_sig FROM idx_state")).rows[0].cursor_sig).toBe(w.txs[w.txs.length - 1].signature);
  });
});
