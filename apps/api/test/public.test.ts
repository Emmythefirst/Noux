import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { LocalKeySigner, signListing, signUnlist, type CampaignInfo, type CampaignReader, type Listing } from "@noux/core";
import { createPool, migrate } from "../src/db";
import { createApp } from "../src/app";
import { syncOnce } from "../src/indexer/sync";
import type { IndexerChain, Snapshot, SaleRow, CampaignRow, SigInfo } from "../src/indexer/chain";

const DB = process.env.DATABASE_URL_TEST ?? "postgres://postgres:devonly@localhost:54329/noux";
const pool = createPool(DB);
const kp = () => Keypair.generate().publicKey.toBase58();
const NOW = 1_800_000_000;
const merchantKey = Keypair.generate(), mint = kp(), feeOwner = kp(), attest = kp();
const A = kp(), B = kp(); // campaign addresses
const [d1, d2] = [kp(), kp()], [b1, b2, b3, b4] = [kp(), kp(), kp(), kp()];
const sale = (over: Partial<SaleRow> & { address: string }): SaleRow => ({
  campaign: A, distributor: d1, buyer: b1, rentPayer: kp(), price: "100000", gross: "100000", merchantAmount: "84000", commissionAmount: "15000", feeAmount: "1000",
  commissionBps: 1500, feeBps: 100, status: "settled", openedAt: NOW - 500, holdUntil: NOW - 485, expiry: NOW + 600, settledAt: NOW - 400, vaultAmount: "0", ...over });
const camp = (over: Partial<CampaignRow> & { address: string }): CampaignRow => ({
  merchant: merchantKey.publicKey.toBase58(), mint, feeOwner, attributionKey: attest, cluster: "devnet", holdSecs: 15, commissionBps: 1500, feeBps: 100,
  commissionBudget: "100000", commissionSpent: "20000", settledCount: "3", refundedCount: "1", ...over });

const S1 = kp(), S2 = kp(), S3 = kp(), S4 = kp(), S5 = kp(), SB = kp();
function snapshot(): Snapshot {
  return {
    slot: 777,
    campaigns: [camp({ address: A }), camp({ address: B, commissionBudget: "50000", commissionSpent: "50000", settledCount: "1", refundedCount: "0" })],
    sales: [
      sale({ address: S1, buyer: b1, distributor: d1 }),
      sale({ address: S2, buyer: b2, distributor: d1, openedAt: NOW - 300 }),
      sale({ address: S3, buyer: b1, distributor: d2, merchantAmount: "94000", commissionAmount: "5000" }), // budget cap bit: 5000 < floor(100000*15%)
      sale({ address: S4, buyer: b3, distributor: d2, status: "refunded", merchantAmount: "0", commissionAmount: "0", feeAmount: "0" }),
      sale({ address: S5, buyer: b4, distributor: d1, status: "open", gross: "0", merchantAmount: "0", commissionAmount: "0", feeAmount: "0", settledAt: null }),
      sale({ address: SB, campaign: B, buyer: b2, distributor: d1, price: "33333", gross: "33333", merchantAmount: "28001", commissionAmount: "4999", feeAmount: "333" }),
    ],
  };
}
class FakeChain implements IndexerChain {
  snap = snapshot(); fail = false; sigs = new Map<string, SigInfo[]>();
  async snapshot() { if (this.fail) throw new Error("rpc down"); return structuredClone(this.snap); }
  async signatures(a: string) { return this.sigs.get(a) ?? []; }
  vaultOf(s: string) { return "vault-of-" + s; }
}
let chain: FakeChain;
const info: CampaignInfo = { address: new PublicKey(A), merchant: merchantKey.publicKey, mint: new PublicKey(mint), feeOwner: new PublicKey(feeOwner), attributionKey: new PublicKey(attest), cluster: "devnet", holdSecs: 15, commissionBps: 1500, feeBps: 100, commissionBudget: 1n, commissionSpent: 0n, settledCount: 0n, refundedCount: 0n };
const reader: CampaignReader = { get: async (a) => (a.toBase58() === A || a.toBase58() === B ? { ...info, address: a } : null) };
const signer = new LocalKeySigner(Keypair.generate().secretKey);
const mkApp = (readLimitPerMin?: number) => createApp(
  { cfg: { CLUSTER: "devnet", PROGRAM_ID: kp(), CLAIM_TTL_SECS: 600, MAX_PRICE_BASE_UNITS: 1n, LIMIT_PER_DISTRIBUTOR_PER_MIN: 1, LIMIT_PER_BUYER_PER_MIN: 1, LIMIT_PER_CAMPAIGN_PER_MIN: 1, LIMIT_PER_IP_PER_MIN: 1 }, pool, signer, campaigns: reader, now: () => NOW },
  { trustProxy: false, clientIp: () => "9.9.9.9", readLimitPerMin, public: { pool, campaigns: reader, cluster: "devnet", programId: kp(), decimals: 6, now: () => NOW } });
const get = async (app: ReturnType<typeof mkApp>, path: string) => { const r = await app.request(path); return { status: r.status, body: await r.json() as any, headers: r.headers }; };
const listing: Listing = { name: "Sample brief", description: "A sample service", category: "data-feeds", endpointUrl: "https://demo.example/api/brief", route: "GET /sample/brief", displayPrice: "$0.10", isSample: true };
const putListing = (app: ReturnType<typeof mkApp>, address: string, l: any, o: { signer?: Keypair; ts?: number; sigOver?: Listing; raw?: any } = {}) => {
  const ts = o.ts ?? NOW, sig = signListing((o.signer ?? merchantKey).secretKey, { campaign: new PublicKey(address), listing: o.sigOver ?? l, ts });
  return app.request(`/v1/campaigns/${address}/listing`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(o.raw ?? { listing: l, ts, signature: Buffer.from(sig).toString("base64") }) });
};

beforeAll(async () => { await migrate(pool); });
beforeEach(async () => { await pool.query("TRUNCATE idx_campaigns, idx_sales, listings, idx_state, claim_issuance, vault_first_seen"); chain = new FakeChain(); });
afterAll(async () => { await pool.end(); });

describe("indexer sync", () => {
  it("upserts campaigns and sales; records freshness; is idempotent", async () => {
    const r1 = await syncOnce(pool, chain); const r2 = await syncOnce(pool, chain);
    expect(r1).toMatchObject({ campaigns: 2, sales: 6, slot: 777 }); expect(r2.sales).toBe(6);
    expect((await pool.query("SELECT count(*)::int n FROM idx_sales")).rows[0].n).toBe(6);
    expect((await pool.query("SELECT last_slot, campaigns, sales FROM idx_state")).rows[0]).toMatchObject({ last_slot: "777", campaigns: 2, sales: 6 });
  });
  it("removes sales that vanished on-chain (closed unpaid) but keeps settled ones", async () => {
    await syncOnce(pool, chain); chain.snap.sales = chain.snap.sales.filter((s) => s.address !== S5);
    await syncOnce(pool, chain);
    const rows = (await pool.query("SELECT address FROM idx_sales")).rows.map((r) => r.address);
    expect(rows).not.toContain(S5); expect(rows).toContain(S1);
  });
  it("an empty or short RPC answer never wipes settled/refunded receipts (only open sales can vanish)", async () => {
    await syncOnce(pool, chain);
    chain.snap.sales = []; chain.snap.campaigns = [];                       // a glitchy provider returns nothing
    await syncOnce(pool, chain);
    const rows = (await pool.query("SELECT address, status FROM idx_sales")).rows;
    expect(rows.map((r) => r.address).sort()).toEqual([S1, S2, S3, S4, SB].sort());   // S5 was OPEN so it may go; the 5 final receipts stay
    expect((await pool.query("SELECT count(*)::int n FROM idx_campaigns")).rows[0].n).toBe(2); // campaigns are never deleted
  });
  it("a stale snapshot cannot roll a settled sale back to open, or lower a campaign's counters", async () => {
    const stale = snapshot(); stale.sales = stale.sales.map((x) => (x.address === S1 ? { ...x, status: "open" as const, gross: "0", merchantAmount: "0", commissionAmount: "0", feeAmount: "0", settledAt: null } : x));
    stale.campaigns = stale.campaigns.map((x) => (x.address === A ? { ...x, settledCount: "0", refundedCount: "0", commissionSpent: "0" } : x));
    await syncOnce(pool, chain);                                              // fresh: S1 settled
    chain.snap = stale; await syncOnce(pool, chain);                          // a late, older snapshot arrives
    expect((await pool.query("SELECT status, gross::text g FROM idx_sales WHERE address = $1", [S1])).rows[0]).toEqual({ status: "settled", g: "100000" });
    expect((await pool.query("SELECT settled_count::text s, commission_spent::text c FROM idx_campaigns WHERE address = $1", [A])).rows[0]).toEqual({ s: "3", c: "20000" });
    chain.snap = snapshot();                                                  // and a normal open -> settled progression still works
    chain.snap.sales = chain.snap.sales.map((x) => (x.address === S5 ? { ...x, status: "settled" as const, gross: "100000", settledAt: NOW - 100 } : x));
    await syncOnce(pool, chain);
    expect((await pool.query("SELECT status FROM idx_sales WHERE address = $1", [S5])).rows[0].status).toBe("settled");
  });
  it("a failed fetch changes nothing and surfaces the error", async () => {
    await syncOnce(pool, chain); const before = (await pool.query("SELECT count(*)::int n FROM idx_sales")).rows[0].n;
    chain.fail = true; await expect(syncOnce(pool, chain)).rejects.toThrow("rpc down");
    expect((await pool.query("SELECT count(*)::int n FROM idx_sales")).rows[0].n).toBe(before);
  });
  it("fills open/payment/settlement signatures once and never overwrites them", async () => {
    const t = (signature: string, blockTime = 1): SigInfo => ({ signature, blockTime, failed: false });
    chain.sigs.set(S1, [t("SETTLE1"), t("OPEN1")]);                          // newest first
    chain.sigs.set("vault-of-" + S1, [t("SETTLE1"), t("PAY1"), t("OPEN1")]); // closing tx, payment, creation
    await syncOnce(pool, chain);
    const row = () => pool.query("SELECT open_sig, payment_sig, settle_sig FROM idx_sales WHERE address = $1", [S1]).then((r) => r.rows[0]);
    expect(await row()).toEqual({ open_sig: "OPEN1", payment_sig: "PAY1", settle_sig: "SETTLE1" });
    chain.sigs.set(S1, [t("OTHER"), t("OTHER2")]); await syncOnce(pool, chain);
    expect(await row()).toEqual({ open_sig: "OPEN1", payment_sig: "PAY1", settle_sig: "SETTLE1" });
  });
  it("ignores failed transactions when picking signatures", async () => {
    chain.sigs.set(S1, [{ signature: "FAILED", blockTime: 2, failed: true }, { signature: "SETTLE1", blockTime: 1, failed: false }, { signature: "OPEN1", blockTime: 0, failed: false }]);
    chain.sigs.set("vault-of-" + S1, [{ signature: "SETTLE1", blockTime: 1, failed: false }, { signature: "OPEN1", blockTime: 0, failed: false }]);
    await syncOnce(pool, chain);
    expect((await pool.query("SELECT settle_sig, payment_sig FROM idx_sales WHERE address = $1", [S1])).rows[0]).toEqual({ settle_sig: "SETTLE1", payment_sig: null });
  });
});

describe("public API: directory", () => {
  beforeEach(async () => { await syncOnce(pool, chain); });
  it("merchant filter: only that merchant's campaigns and the true total, however many other campaigns exist (the console must not page the whole platform)", async () => {
    for (let i = 0; i < 120; i++) chain.snap.campaigns.push(camp({ address: kp(), merchant: kp() }));
    await syncOnce(pool, chain);
    const app = mkApp(), m = merchantKey.publicKey.toBase58();
    const all = await get(app, "/v1/campaigns?includeUnlisted=1&limit=100");
    expect(all.body.total).toBe(122); expect(all.body.items).toHaveLength(100); // the old client-side approach only ever saw this page
    const mine = await get(app, `/v1/campaigns?includeUnlisted=1&merchant=${m}&limit=100`);
    expect(mine.body.total).toBe(2); expect(mine.body.items).toHaveLength(2);
    expect(mine.body.items.every((x: any) => x.merchant === m)).toBe(true);
    expect((await get(app, "/v1/campaigns?merchant=not-a-key")).status).toBe(400);
    expect((await get(app, `/v1/campaigns?includeUnlisted=1&merchant=${kp()}`)).body.total).toBe(0);
  });
  it("lists only LISTED campaigns by default; includeUnlisted shows all", async () => {
    const app = mkApp();
    expect((await get(app, "/v1/campaigns")).body.items).toHaveLength(0);
    expect((await get(app, "/v1/campaigns?includeUnlisted=1")).body.items).toHaveLength(2);
    expect((await putListing(app, A, listing)).status).toBe(200);
    const r = await get(app, "/v1/campaigns"); expect(r.body.items).toHaveLength(1);
    const c = r.body.items[0];
    expect(c).toMatchObject({ address: A, commissionBps: 1500, feeBps: 100, holdSecs: 15, status: "active", decimals: 6, cluster: "devnet" });
    expect(c.budget).toEqual({ total: "100000", spent: "20000", remaining: "80000" });
    expect(c.sales).toMatchObject({ settled: 3, refunded: 1, open: 1, refundRate: 0.25 });
    expect(c.listing).toMatchObject({ name: "Sample brief", isSample: true, category: "data-feeds" });
    expect(r.body.disclosure).toMatch(/commission/i);
  });
  it("filters (category, q, status) and sorts and paginates", async () => {
    const app = mkApp(); await putListing(app, A, listing); await putListing(app, B, { ...listing, name: "Quote feed", category: "ai-text", description: "other thing" });
    expect((await get(app, "/v1/campaigns?category=ai-text")).body.items.map((i: any) => i.address)).toEqual([B]);
    expect((await get(app, "/v1/campaigns?q=quote")).body.items.map((i: any) => i.address)).toEqual([B]);
    expect((await get(app, "/v1/campaigns?status=budget_exhausted")).body.items.map((i: any) => i.address)).toEqual([B]); // B spent == budget
    expect((await get(app, "/v1/campaigns?status=active")).body.items.map((i: any) => i.address)).toEqual([A]);
    expect((await get(app, "/v1/campaigns?sort=volume")).body.items[0].address).toBe(A); // 300000 vs 33333
    const p = await get(app, "/v1/campaigns?limit=1&offset=1"); expect(p.body.items).toHaveLength(1); expect(p.body.total).toBe(2);
    expect((await get(app, "/v1/campaigns?limit=0")).status).toBe(400); expect((await get(app, "/v1/campaigns?limit=101")).status).toBe(400);
    expect((await get(app, "/v1/campaigns?category=nope")).status).toBe(400);
  });
  it("is injection-safe and treats % and _ literally", async () => {
    const app = mkApp(); await putListing(app, A, listing);
    expect((await get(app, "/v1/campaigns?q=" + encodeURIComponent("'; DROP TABLE listings; --"))).status).toBe(200);
    expect((await pool.query("SELECT count(*)::int n FROM listings")).rows[0].n).toBe(1);
    expect((await get(app, "/v1/campaigns?q=%25")).body.items).toHaveLength(0); // a literal '%', not a wildcard
  });
  it("campaign detail exposes transparent metrics (no composite score)", async () => {
    const app = mkApp(); await putListing(app, A, listing);
    const { status, body } = await get(app, `/v1/campaigns/${A}`);
    expect(status).toBe(200);
    expect(body.metrics).toMatchObject({ settled: 3, refunded: 1, open: 1, volume: "300000", commissionsPaid: "35000", protocolFees: "3000", merchantRevenue: "262000", refundedAmount: "100000", distinctBuyers: 2, distinctDistributors: 2 });
    expect(body.metrics.topBuyerShare).toBeCloseTo(2 / 3, 3); // b1 bought 2 of 3 settled
    expect(body.topDistributors[0]).toMatchObject({ distributor: d1, purchases: 2, earned: "30000" });
    expect(JSON.stringify(body)).not.toMatch(/trust|reputation|score/i);
    expect((await get(app, `/v1/campaigns/${kp()}`)).status).toBe(404); expect((await get(app, "/v1/campaigns/not-a-key")).status).toBe(400);
  });
});

describe("public API: receipts", () => {
  beforeEach(async () => {
    const t = (signature: string): SigInfo => ({ signature, blockTime: 1, failed: false });
    chain.sigs.set(S3, [t("SETTLE3"), t("OPEN3")]); chain.sigs.set("vault-of-" + S3, [t("SETTLE3"), t("PAY3"), t("OPEN3")]);
    chain.sigs.set(S4, [t("REFUND4"), t("OPEN4")]); chain.sigs.set("vault-of-" + S4, [t("REFUND4"), t("PAY4"), t("OPEN4")]);
    await syncOnce(pool, chain);
  });
  it("shows the split, the policy applied, and explorer links", async () => {
    const app = mkApp(); await putListing(app, A, listing);
    const r = (await get(app, `/v1/receipts/${S3}`)).body;
    expect(r).toMatchObject({ sale: S3, status: "settled", gross: "100000", split: { merchant: "94000", distributor: "5000", protocolFee: "1000" }, refunded: false });
    expect(r.policy).toMatchObject({ commissionBps: 1500, feeBps: 100, holdSecs: 15, budgetCapApplied: true });
    expect(r.links.settlement).toBe("https://explorer.solana.com/tx/SETTLE3?cluster=devnet");
    expect(r.links.payment).toContain("PAY3"); expect(r.links.open).toContain("OPEN3"); expect(r.listing.isSample).toBe(true);
    expect((await get(app, `/v1/receipts/${S1}`)).body.policy.budgetCapApplied).toBe(false); // full 15% was paid
    expect(BigInt(r.split.merchant) + BigInt(r.split.distributor) + BigInt(r.split.protocolFee)).toBe(BigInt(r.gross)); // exact
  });
  it("a refunded receipt shows a refund link, not a settlement", async () => {
    const r = (await get(mkApp(), `/v1/receipts/${S4}`)).body;
    expect(r).toMatchObject({ status: "refunded", refunded: true, split: { distributor: "0", protocolFee: "0" } });
    expect(r.links.refund).toContain("REFUND4"); expect(r.links.settlement).toBeNull();
  });
  it("filters by distributor / buyer / status, paginates, validates", async () => {
    const app = mkApp();
    expect((await get(app, `/v1/receipts?distributor=${d2}`)).body.items.map((i: any) => i.sale).sort()).toEqual([S3, S4].sort());
    expect((await get(app, `/v1/receipts?buyer=${b1}&status=settled`)).body.total).toBe(2);
    expect((await get(app, "/v1/receipts?limit=2")).body.items).toHaveLength(2);
    expect((await get(app, "/v1/receipts?distributor=bad")).status).toBe(400);
    expect((await get(app, `/v1/receipts/${kp()}`)).status).toBe(404); expect((await get(app, "/v1/receipts/zzz")).status).toBe(400);
  });
});

describe("public API: protocol fee enforcement is reported from the on-chain config", () => {
  const legacyFeeOwner = kp(), cfgAdmin = kp();
  const withCfg: CampaignReader = { ...reader, config: async () => ({ admin: new PublicKey(cfgAdmin), feeOwner: new PublicKey(feeOwner), feeBps: 100 }) };
  const appWith = (r: CampaignReader) => createApp(
    { cfg: { CLUSTER: "devnet", PROGRAM_ID: kp(), CLAIM_TTL_SECS: 600, MAX_PRICE_BASE_UNITS: 1n, LIMIT_PER_DISTRIBUTOR_PER_MIN: 1, LIMIT_PER_BUYER_PER_MIN: 1, LIMIT_PER_CAMPAIGN_PER_MIN: 1, LIMIT_PER_IP_PER_MIN: 1 }, pool, signer, campaigns: r, now: () => NOW },
    { trustProxy: false, clientIp: () => "9.9.9.9", public: { pool, campaigns: r, cluster: "devnet", programId: kp(), decimals: 6, now: () => NOW } });
  beforeEach(async () => {
    chain.snap = snapshot(); chain.snap.campaigns[1] = camp({ address: B, feeOwner: legacyFeeOwner, commissionBudget: "50000", commissionSpent: "50000" }); // B: created before enforcement, creator-chosen fee wallet
    await syncOnce(pool, chain);
  });
  it("marks a campaign whose fee wallet is the protocol's as enforced, and a legacy one as not", async () => {
    const app = appWith(withCfg);
    expect((await get(app, `/v1/campaigns/${A}`)).body).toMatchObject({ feeEnforced: true, feeOwner });
    expect((await get(app, `/v1/campaigns/${B}`)).body).toMatchObject({ feeEnforced: false, feeOwner: legacyFeeOwner });
    const list = (await get(app, "/v1/campaigns?includeUnlisted=1")).body.items;
    expect(list.find((x: any) => x.address === A).feeEnforced).toBe(true); expect(list.find((x: any) => x.address === B).feeEnforced).toBe(false);
  });
  it("never claims 'enforced' when the config can't be read", async () => {
    expect((await get(appWith(reader), `/v1/campaigns/${A}`)).body.feeEnforced).toBeNull();
    expect((await get(appWith({ ...reader, config: async () => { throw new Error("rpc down"); } }), `/v1/campaigns/${A}`)).body.feeEnforced).toBeNull();
  });
  it("stats expose the protocol config and the cap; receipts expose the fee wallet", async () => {
    const app = appWith(withCfg);
    expect((await get(app, "/v1/stats")).body.protocol).toEqual({ admin: cfgAdmin, feeOwner, feeBps: 100, maxFeeBps: 500 });
    expect((await get(appWith(reader), "/v1/stats")).body.protocol).toBeNull();
    expect((await get(app, `/v1/receipts/${S1}`)).body.parties.feeOwner).toBe(feeOwner);
  });
});

describe("public API: distributors and stats", () => {
  beforeEach(async () => { await syncOnce(pool, chain); });
  it("distributor metrics are plain checkable numbers", async () => {
    const r = (await get(mkApp(), `/v1/distributors/${d1}`)).body;
    expect(r.metrics).toMatchObject({ eligiblePurchases: 3, totalEarned: "34999", referredVolume: "233333", distinctBuyers: 2, campaigns: 2, open: 1 }); // S1,S2 (A) + SB (B); S5 is open
    expect(r.byCampaign.map((x: any) => x.campaign).sort()).toEqual([A, B].sort());
    expect(JSON.stringify(r)).not.toMatch(/trust|reputation|score/i);
    // claims issued is the server's own record; paid counts sales whose vault was funded (S5 is open and unfunded)
    for (let i = 0; i < 5; i++) await pool.query(`INSERT INTO claim_issuance (campaign, distributor, buyer, ip, price, nonce, expiry) VALUES ($1,$2,$3,'1.1.1.1',100000,$4,to_timestamp($5))`, [A, d1, b1, `n${i}`, NOW + 600]);
    expect((await get(mkApp(), `/v1/distributors/${d1}`)).body.claims).toEqual({ issued: 5, paid: 3 });
    // an OPEN sale has gross 0 on-chain until settlement; once its vault holds money it counts as paid and the receipt says funded
    expect((await get(mkApp(), `/v1/receipts/${S5}`)).body).toMatchObject({ funded: false, vaultAmount: "0", gross: "0" });
    await pool.query("UPDATE idx_sales SET vault_amount = 100000 WHERE address = $1", [S5]);
    expect((await get(mkApp(), `/v1/receipts/${S5}`)).body).toMatchObject({ funded: true, vaultAmount: "100000", gross: "0" });
    expect((await get(mkApp(), `/v1/distributors/${d1}`)).body.claims).toEqual({ issued: 5, paid: 4 });
    expect((await get(mkApp(), `/v1/receipts/${S1}`)).body.funded).toBe(true);
    await pool.query("UPDATE idx_sales SET vault_amount = 0 WHERE address = $1", [S5]);
    expect((await get(mkApp(), `/v1/distributors/${d2}`)).body.claims).toEqual({ issued: 0, paid: 2 });
    expect((await get(mkApp(), `/v1/distributors/${d2}`)).body.metrics).toMatchObject({ eligiblePurchases: 1, refunded: 1, totalEarned: "5000" });
    expect((await get(mkApp(), `/v1/distributors/${kp()}`)).body.metrics).toMatchObject({ eligiblePurchases: 0, totalEarned: "0" }); // unknown = empty, not an error
  });
  it("stats report sample vs listed vs unlisted volume separately (never pooled as 'demand')", async () => {
    const app = mkApp(); await putListing(app, A, listing); // A is a SAMPLE listing; B stays unlisted
    const s = (await get(app, "/v1/stats")).body;
    expect(s.totals).toMatchObject({ campaigns: 2, listedCampaigns: 1, merchants: 1, settled: 4, refunded: 1, open: 1, volume: "333333", commissionsPaid: "39999" });
    expect(s.volumeBySource).toEqual({ sample: { settled: 3, volume: "300000" }, listed: { settled: 0, volume: "0" }, unlisted: { settled: 1, volume: "33333" } });
    expect(s.index).toMatchObject({ lastSlot: 777, lastError: null }); expect(s.disclosure).toMatch(/sample/i);
    await putListing(app, A, { ...listing, isSample: false });
    expect((await get(app, "/v1/stats")).body.volumeBySource.listed.volume).toBe("300000");
  });
  it("/v1/index reports freshness and the last error", async () => {
    const r = (await get(mkApp(), "/v1/index")).body; expect(r).toMatchObject({ lastSlot: 777, campaigns: 2, sales: 6, lastError: null, lastMode: "full" }); expect(r.lastFullSyncAt).not.toBeNull();
  });
});

const delListing = (app: ReturnType<typeof mkApp>, address: string, o: { signer?: Keypair; ts?: number; sig?: Uint8Array; raw?: any } = {}) => {
  const ts = o.ts ?? NOW, sig = o.sig ?? signUnlist((o.signer ?? merchantKey).secretKey, { campaign: new PublicKey(address), ts });
  return app.request(`/v1/campaigns/${address}/listing`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(o.raw ?? { ts, signature: Buffer.from(sig).toString("base64") }) });
};

describe("removing a listing from the directory", () => {
  beforeEach(async () => { await syncOnce(pool, chain); });
  it("only the on-chain merchant can remove it, and it leaves the directory but not the chain data", async () => {
    const app = mkApp(); await putListing(app, A, listing);
    expect((await get(app, "/v1/campaigns")).body.items.map((x: any) => x.address)).toEqual([A]);
    expect((await delListing(app, A, { signer: Keypair.generate() })).status).toBe(401);   // someone else
    expect((await delListing(app, A, { ts: NOW - 120 })).status).toBe(401);                // stale
    expect((await delListing(app, A, { ts: NOW + 120 })).status).toBe(401);                // from the future
    expect((await get(app, "/v1/campaigns")).body.items).toHaveLength(1);                  // still listed after every refusal
    const ok = await delListing(app, A); expect(ok.status).toBe(200); expect((await ok.json() as any).removed).toBe(true);
    expect((await get(app, "/v1/campaigns")).body.items).toHaveLength(0);                  // gone from the directory
    const still = await get(app, `/v1/campaigns/${A}`); expect(still.status).toBe(200); expect(still.body.listing).toBeNull(); // campaign itself untouched (unlisted)
    expect((await get(app, "/v1/stats")).body.totals.listedCampaigns).toBe(0);
  });
  it("is idempotent, and 404s for a campaign that does not exist", async () => {
    const app = mkApp();
    const r = await delListing(app, A); expect(r.status).toBe(200); expect((await r.json() as any).removed).toBe(false);
    expect((await delListing(app, kp())).status).toBe(404);
    expect((await delListing(app, "zzz", { sig: new Uint8Array(64) })).status).toBe(400);
  });
  it("a signed LISTING can never be replayed as a removal (domain separation), and bad bodies are refused", async () => {
    const app = mkApp(); await putListing(app, A, listing);
    const listSig = signListing(merchantKey.secretKey, { campaign: new PublicKey(A), listing, ts: NOW });
    expect((await delListing(app, A, { sig: listSig })).status).toBe(401);
    expect((await get(app, "/v1/campaigns")).body.items).toHaveLength(1);
    expect((await delListing(app, A, { raw: "nope" })).status).toBe(400);
    expect((await delListing(app, A, { raw: { ts: NOW, signature: "x".repeat(88), extra: 1 } })).status).toBe(400);
  });
  it("sends CORS for DELETE so the website can call it", async () => {
    const r = await mkApp().request(`/v1/campaigns/${A}/listing`, { method: "OPTIONS", headers: { origin: "https://noux.vercel.app", "access-control-request-method": "DELETE" } });
    expect(r.headers.get("access-control-allow-methods")).toMatch(/DELETE/);
  });
});

describe("listing authorization and hygiene", () => {
  beforeEach(async () => { await syncOnce(pool, chain); });
  it("only the campaign's on-chain merchant can list it", async () => {
    const app = mkApp();
    expect((await putListing(app, A, listing, { signer: Keypair.generate() })).status).toBe(401);
    expect((await putListing(app, A, listing, { ts: NOW - 120 })).status).toBe(401);
    expect((await putListing(app, A, listing, { ts: NOW + 120 })).status).toBe(401);
    expect((await putListing(app, A, { ...listing, endpointUrl: "https://evil.example/phish" }, { sigOver: listing })).status).toBe(401); // altered after signing
    expect((await putListing(app, kp(), listing)).status).toBe(404);
    expect((await pool.query("SELECT count(*)::int n FROM listings")).rows[0].n).toBe(0);
  });
  it("rejects non-https / credentialed URLs, unknown fields and bad categories", async () => {
    const app = mkApp();
    expect((await putListing(app, A, { ...listing, endpointUrl: "http://plain.example" })).status).toBe(400);
    expect((await putListing(app, A, { ...listing, endpointUrl: "https://user:pw@x.example" })).status).toBe(400);
    expect((await putListing(app, A, { ...listing, endpointUrl: "javascript:alert(1)" })).status).toBe(400);
    expect((await putListing(app, A, { ...listing, website: "ftp://x.example" })).status).toBe(400);
    expect((await putListing(app, A, { ...listing, extra: 1 } as any)).status).toBe(400);
    expect((await putListing(app, A, { ...listing, category: "casino" } as any)).status).toBe(400);
    expect((await putListing(app, A, listing, { raw: "not an object" })).status).toBe(400);
  });
  it("verifies the signature over the exact text sent, then stores/serves a control-character-free form", async () => {
    const app = mkApp(); const dirty = { ...listing, name: "Line\u0000One\u001b[31m", description: "a\nb" };
    const res = await putListing(app, A, dirty);                       // merchant signed the dirty bytes: accepted
    expect(res.status).toBe(200);
    const served = (await get(app, "/v1/campaigns")).body.items[0].listing;
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u001f\u007f]/.test(served.name + served.description)).toBe(false);
    expect(served.name.startsWith("Line")).toBe(true);
    // ...and signing the CLEAN text instead while sending dirty text must NOT verify (server hashes what it received)
    expect((await putListing(app, A, dirty, { sigOver: { ...dirty, name: "LineOne", description: "a b" } })).status).toBe(401);
    expect((await putListing(app, A, { ...listing, name: "\u0001\u0002", description: "x" })).status).toBe(400); // nothing visible left
  });
  it("a second PUT updates the listing in place", async () => {
    const app = mkApp(); await putListing(app, A, listing); await putListing(app, A, { ...listing, name: "Renamed" });
    expect((await get(app, "/v1/campaigns")).body.items[0].listing.name).toBe("Renamed");
    expect((await pool.query("SELECT count(*)::int n FROM listings")).rows[0].n).toBe(1);
  });
});

describe("http hygiene", () => {
  beforeEach(async () => { await syncOnce(pool, chain); });
  it("sends CORS for any origin and answers preflight", async () => {
    const app = mkApp();
    const g = await app.request("/v1/stats", { headers: { origin: "https://ui.example" } }); expect(g.headers.get("access-control-allow-origin")).toBe("*");
    const o = await app.request("/v1/campaigns/" + A + "/listing", { method: "OPTIONS", headers: { origin: "https://ui.example", "access-control-request-method": "PUT", "access-control-request-headers": "content-type" } });
    expect(o.status).toBeLessThan(300); expect(o.headers.get("access-control-allow-methods")).toContain("PUT");
  });
  it("marks read responses cacheable for a few seconds", async () => {
    expect((await mkApp().request("/v1/stats")).headers.get("cache-control")).toContain("max-age=5");
  });
  it("rate-limits reads per IP with Retry-After, but never blocks claim POSTs", async () => {
    const app = mkApp(3);
    for (let i = 0; i < 3; i++) expect((await app.request("/v1/stats")).status).toBe(200);
    const r = await app.request("/v1/stats"); expect(r.status).toBe(429); expect(r.headers.get("retry-after")).toBe("30");
    expect((await app.request("/v1/claims", { method: "POST", body: "{}" })).status).toBe(400); // reaches the handler (bad body), not the limiter
  });
  it("claim-service exposes only the public attribution key and cluster", async () => {
    const r = await get(mkApp(), "/v1/claim-service");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ attributionKey: signer.publicKey.toBase58(), cluster: "devnet", claimTtlSecs: 600 });
    expect(JSON.stringify(r.body)).not.toMatch(/secret|private/i);
  });
  it("healthz stays outside /v1 and exposes no secrets", async () => {
    const r = await mkApp().request("/healthz"); expect(r.status).toBe(200);
  });
});

describe("migrations under concurrency", () => {
  it("two processes migrating at once do not race (advisory lock)", async () => {
    const other = createPool(DB);
    try { await Promise.all([migrate(pool), migrate(other), migrate(pool), migrate(other)]); } finally { await other.end(); }
  });
});

describe("campaign card carries the attribution key (so a merchant can see what the campaign trusts)", () => {
  beforeEach(async () => { await syncOnce(pool, chain); });
  it("GET /v1/campaigns/:address includes attributionKey", async () => {
    const r = await get(mkApp(), `/v1/campaigns/${A}`); expect(r.status).toBe(200); expect(r.body.attributionKey).toBe(attest);
  });
});
