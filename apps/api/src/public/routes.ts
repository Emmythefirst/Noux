import { Hono } from "hono";
import { z } from "zod";
import type pg from "pg";
import { PublicKey } from "@solana/web3.js";
import { LISTING_CATEGORIES, verifyListing, verifyUnlist, type CampaignReader, type Listing } from "@noux/core";

export const DISCLOSURE =
  "Distributors earn a commission when a buyer they referred pays for this service. Listings and rankings are not endorsements. " +
  "Services marked 'sample' were built by the Noux team for demonstration; their volume is not real market demand.";

export interface PublicDeps { pool: pg.Pool; campaigns: CampaignReader; cluster: string; programId: string; decimals: number; now?: () => number }

const isPk = (s: string) => { if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false; try { new PublicKey(s); return true; } catch { return false; } };
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").trim();

const listingBody = z.object({
  listing: z.object({
    name: z.string().min(1).max(60), description: z.string().min(1).max(280),
    category: z.enum(LISTING_CATEGORIES), endpointUrl: z.string().url().max(200), route: z.string().min(1).max(80),
    displayPrice: z.string().min(1).max(20), website: z.string().url().max(200).optional(), isSample: z.boolean(),
  }).strict(),
  ts: z.number().int(), signature: z.string().min(80).max(100),
}).strict();
const httpsOnly = (u: string) => { try { const x = new URL(u); return x.protocol === "https:" && !x.username && !x.password; } catch { return false; } };

const page = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).default(0) });

export function publicRoutes(d: PublicDeps) {
  const app = new Hono();
  const now = () => (d.now ?? (() => Math.floor(Date.now() / 1000)))();
  const txUrl = (sig: string | null) => (sig ? `https://explorer.solana.com/tx/${sig}${d.cluster === "devnet" ? "?cluster=devnet" : ""}` : null);
  const acctUrl = (a: string) => `https://explorer.solana.com/address/${a}${d.cluster === "devnet" ? "?cluster=devnet" : ""}`;
  const iso = (v: Date | null) => (v ? new Date(v).toISOString() : null);
  const bad = (c: any, status: 400 | 404, code: string, message: string) => c.json({ error: { code, message } }, status);
  const cache = (c: any) => c.header("Cache-Control", "public, max-age=5, stale-while-revalidate=30");

  const listingOf = (r: any) => (r.l_name === null || r.l_name === undefined ? null : {
    name: r.l_name, description: r.l_description, category: r.l_category, endpointUrl: r.l_endpoint_url, route: r.l_route,
    displayPrice: r.l_display_price, website: r.l_website, isSample: r.l_is_sample, updatedAt: iso(r.l_updated_at),
  });
  const LJ = `l.name l_name, l.description l_description, l.category l_category, l.endpoint_url l_endpoint_url, l.route l_route, l.display_price l_display_price, l.website l_website, l.is_sample l_is_sample, l.updated_at l_updated_at`;

  // protocol fee config, read from the chain (cached 30 s); null when it can't be read (then nothing claims "enforced")
  const protocol = async () => { try { return (await d.campaigns.config?.()) ?? null; } catch { return null; } };
  const card = (r: any, cfg: { feeOwner: PublicKey } | null = null) => {
    const total = BigInt(r.commission_budget), spent = BigInt(r.commission_spent), remaining = total > spent ? total - spent : 0n;
    const settled = Number(r.settled_count), refunded = Number(r.refunded_count);
    return {
      address: r.address, merchant: r.merchant, mint: r.mint, decimals: d.decimals, cluster: r.cluster,
      commissionBps: r.commission_bps, feeBps: r.fee_bps, holdSecs: r.hold_secs,
      // true: the fee wallet is the protocol's (set by the program's config). false: a legacy campaign created before enforcement. null: unknown.
      feeOwner: r.fee_owner, feeEnforced: cfg ? r.fee_owner === cfg.feeOwner.toBase58() : null,
      budget: { total: total.toString(), spent: spent.toString(), remaining: remaining.toString() },
      status: remaining > 0n ? "active" : "budget_exhausted",
      sales: { settled, refunded, open: Number(r.open_n ?? 0), refundRate: settled + refunded > 0 ? refunded / (settled + refunded) : null },
      volume: r.volume === undefined ? undefined : String(r.volume),
      listing: listingOf(r), links: { account: acctUrl(r.address) },
    };
  };

  const receipt = (r: any) => {
    const gross = BigInt(r.gross), com = BigInt(r.commission_amount);
    const wanted = (gross * BigInt(r.commission_bps)) / 10000n;
    return {
      sale: r.address, campaign: r.campaign, status: r.status, cluster: d.cluster, decimals: d.decimals,
      parties: { merchant: r.merchant, distributor: r.distributor, buyer: r.buyer, feeOwner: r.fee_owner },
      price: String(r.price), gross: String(r.gross),
      // For an OPEN sale `gross` is 0 until settlement: `vaultAmount` is what the buyer has paid into the vault so far, `funded` says whether anything has been.
      vaultAmount: String(r.vault_amount ?? 0), funded: r.status === "open" ? BigInt(String(r.vault_amount ?? 0).split(".")[0]) > 0n : BigInt(String(r.gross).split(".")[0]) > 0n,
      split: { merchant: String(r.merchant_amount), distributor: String(r.commission_amount), protocolFee: String(r.fee_amount) },
      policy: {
        commissionBps: r.commission_bps, feeBps: r.fee_bps, holdSecs: r.hold_secs, rounding: "amounts are floored; the remainder goes to the merchant",
        budgetCapApplied: r.status === "settled" && com < wanted,
      },
      refunded: r.status === "refunded",
      openedAt: iso(r.opened_at), settledAt: iso(r.settled_at), holdUntil: iso(r.hold_until),
      links: { saleAccount: acctUrl(r.address), open: txUrl(r.open_sig), payment: txUrl(r.payment_sig), settlement: r.status === "refunded" ? null : txUrl(r.settle_sig), refund: r.status === "refunded" ? txUrl(r.settle_sig) : null },
      listing: listingOf(r),
    };
  };
  const RJ = `s.*, c.merchant, c.hold_secs, c.fee_owner, ${LJ}`;
  const RFROM = `FROM idx_sales s JOIN idx_campaigns c ON c.address = s.campaign LEFT JOIN listings l ON l.campaign = s.campaign`;

  /* ---------- directory ---------- */
  app.get("/campaigns", async (c) => {
    const q = z.object({ category: z.enum(LISTING_CATEGORIES).optional(), q: z.string().max(60).optional(), status: z.enum(["active", "budget_exhausted"]).optional(),
      includeUnlisted: z.enum(["0", "1"]).default("0"), merchant: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(), sort: z.enum(["newest", "commission", "volume"]).default("newest") }).merge(page).safeParse(c.req.query());
    if (!q.success) return bad(c, 400, "bad_request", "invalid query: " + q.error.issues.map((i) => i.path.join(".")).join(","));
    const p: any[] = []; const w: string[] = [];
    if (q.data.includeUnlisted === "0") w.push("l.campaign IS NOT NULL");
    if (q.data.merchant) { p.push(q.data.merchant); w.push(`c.merchant = $${p.length}`); }
    if (q.data.category) { p.push(q.data.category); w.push(`l.category = $${p.length}`); }
    if (q.data.q) { p.push(`%${q.data.q.replace(/[%_\\]/g, (m) => "\\" + m)}%`); w.push(`(l.name ILIKE $${p.length} OR l.description ILIKE $${p.length})`); }
    if (q.data.status === "active") w.push("c.commission_budget > c.commission_spent");
    if (q.data.status === "budget_exhausted") w.push("c.commission_budget <= c.commission_spent");
    const where = w.length ? "WHERE " + w.join(" AND ") : "";
    const order = q.data.sort === "commission" ? "c.commission_bps DESC, c.updated_at DESC" : q.data.sort === "volume" ? "volume DESC, c.updated_at DESC" : "COALESCE(l.updated_at, c.updated_at) DESC";
    const total = (await d.pool.query(`SELECT count(*)::int n FROM idx_campaigns c LEFT JOIN listings l ON l.campaign = c.address ${where}`, p)).rows[0].n;
    p.push(q.data.limit, q.data.offset);
    const { rows } = await d.pool.query(
      `SELECT c.*, ${LJ},
         (SELECT count(*) FROM idx_sales s WHERE s.campaign = c.address AND s.status = 'open') open_n,
         (SELECT coalesce(sum(gross), 0) FROM idx_sales s WHERE s.campaign = c.address AND s.status = 'settled') volume
       FROM idx_campaigns c LEFT JOIN listings l ON l.campaign = c.address ${where} ORDER BY ${order} LIMIT $${p.length - 1} OFFSET $${p.length}`, p);
    const cfg = await protocol();
    cache(c); return c.json({ items: rows.map((r) => card(r, cfg)), total, limit: q.data.limit, offset: q.data.offset, disclosure: DISCLOSURE });
  });

  app.get("/campaigns/:address", async (c) => {
    const a = c.req.param("address"); if (!isPk(a)) return bad(c, 400, "bad_request", "invalid address");
    const { rows } = await d.pool.query(`SELECT c.*, ${LJ}, (SELECT count(*) FROM idx_sales s WHERE s.campaign = c.address AND s.status = 'open') open_n FROM idx_campaigns c LEFT JOIN listings l ON l.campaign = c.address WHERE c.address = $1`, [a]);
    if (!rows[0]) return bad(c, 404, "not_found", "no such campaign");
    const st = (await d.pool.query(
      `SELECT count(*) FILTER (WHERE status='settled')::int settled, count(*) FILTER (WHERE status='refunded')::int refunded, count(*) FILTER (WHERE status='open')::int open,
              coalesce(sum(gross) FILTER (WHERE status='settled'),0) volume, coalesce(sum(commission_amount) FILTER (WHERE status='settled'),0) commissions,
              coalesce(sum(fee_amount) FILTER (WHERE status='settled'),0) fees, coalesce(sum(merchant_amount) FILTER (WHERE status='settled'),0) merchant_revenue,
              coalesce(sum(gross) FILTER (WHERE status='refunded'),0) refunded_amount,
              count(DISTINCT buyer) FILTER (WHERE status='settled')::int distinct_buyers, count(DISTINCT distributor) FILTER (WHERE status='settled')::int distinct_distributors
         FROM idx_sales WHERE campaign = $1`, [a])).rows[0];
    const conc = (await d.pool.query(`SELECT coalesce(max(n)::float / NULLIF(sum(n), 0), 0) share FROM (SELECT count(*) n FROM idx_sales WHERE campaign = $1 AND status = 'settled' GROUP BY buyer) t`, [a])).rows[0].share;
    const top = (await d.pool.query(`SELECT distributor, count(*)::int purchases, sum(commission_amount) earned FROM idx_sales WHERE campaign = $1 AND status = 'settled' GROUP BY distributor ORDER BY sum(commission_amount) DESC, count(*) DESC LIMIT 10`, [a])).rows;
    cache(c);
    return c.json({
      ...card(rows[0], await protocol()), disclosure: DISCLOSURE,
      metrics: {
        settled: st.settled, refunded: st.refunded, open: st.open, volume: String(st.volume), commissionsPaid: String(st.commissions), protocolFees: String(st.fees),
        merchantRevenue: String(st.merchant_revenue), refundedAmount: String(st.refunded_amount), distinctBuyers: st.distinct_buyers, distinctDistributors: st.distinct_distributors,
        topBuyerShare: Number(Number(conc).toFixed(4)),
      },
      topDistributors: top.map((t) => ({ distributor: t.distributor, purchases: t.purchases, earned: String(t.earned) })),
    });
  });

  app.get("/campaigns/:address/sales", async (c) => {
    const a = c.req.param("address"); if (!isPk(a)) return bad(c, 400, "bad_request", "invalid address");
    const q = z.object({ status: z.enum(["open", "settled", "refunded"]).optional() }).merge(page).safeParse(c.req.query());
    if (!q.success) return bad(c, 400, "bad_request", "invalid query");
    const p: any[] = [a]; let w = "s.campaign = $1"; if (q.data.status) { p.push(q.data.status); w += ` AND s.status = $${p.length}`; }
    const total = (await d.pool.query(`SELECT count(*)::int n FROM idx_sales s WHERE ${w}`, p)).rows[0].n;
    p.push(q.data.limit, q.data.offset);
    const { rows } = await d.pool.query(`SELECT ${RJ} ${RFROM} WHERE ${w} ORDER BY s.opened_at DESC LIMIT $${p.length - 1} OFFSET $${p.length}`, p);
    cache(c); return c.json({ items: rows.map(receipt), total, limit: q.data.limit, offset: q.data.offset });
  });

  /* ---------- receipts ---------- */
  app.get("/receipts", async (c) => {
    const q = z.object({ campaign: z.string().optional(), distributor: z.string().optional(), buyer: z.string().optional(), status: z.enum(["open", "settled", "refunded"]).optional() }).merge(page).safeParse(c.req.query());
    if (!q.success) return bad(c, 400, "bad_request", "invalid query");
    for (const k of ["campaign", "distributor", "buyer"] as const) if (q.data[k] && !isPk(q.data[k]!)) return bad(c, 400, "bad_request", `invalid ${k}`);
    const p: any[] = []; const w: string[] = [];
    for (const [col, v] of [["s.campaign", q.data.campaign], ["s.distributor", q.data.distributor], ["s.buyer", q.data.buyer], ["s.status", q.data.status]] as const) if (v) { p.push(v); w.push(`${col} = $${p.length}`); }
    const where = w.length ? "WHERE " + w.join(" AND ") : "";
    const total = (await d.pool.query(`SELECT count(*)::int n FROM idx_sales s ${where}`, p)).rows[0].n;
    p.push(q.data.limit, q.data.offset);
    const { rows } = await d.pool.query(`SELECT ${RJ} ${RFROM} ${where} ORDER BY COALESCE(s.settled_at, s.opened_at) DESC LIMIT $${p.length - 1} OFFSET $${p.length}`, p);
    cache(c); return c.json({ items: rows.map(receipt), total, limit: q.data.limit, offset: q.data.offset });
  });
  app.get("/receipts/:sale", async (c) => {
    const a = c.req.param("sale"); if (!isPk(a)) return bad(c, 400, "bad_request", "invalid sale address");
    const { rows } = await d.pool.query(`SELECT ${RJ} ${RFROM} WHERE s.address = $1`, [a]);
    if (!rows[0]) return bad(c, 404, "not_found", "no such receipt (it may not be indexed yet, or the sale was closed unpaid)");
    cache(c); return c.json(receipt(rows[0]));
  });

  /* ---------- distributors ---------- */
  app.get("/distributors/:pubkey", async (c) => {
    const a = c.req.param("pubkey"); if (!isPk(a)) return bad(c, 400, "bad_request", "invalid public key");
    const st = (await d.pool.query(
      `SELECT count(*) FILTER (WHERE status='settled')::int purchases, count(*) FILTER (WHERE status='refunded')::int refunded, count(*) FILTER (WHERE status='open')::int open,
              coalesce(sum(commission_amount) FILTER (WHERE status='settled'),0) earned, coalesce(sum(gross) FILTER (WHERE status='settled'),0) volume,
              count(DISTINCT buyer) FILTER (WHERE status='settled')::int distinct_buyers, count(DISTINCT campaign)::int campaigns
         FROM idx_sales WHERE distributor = $1`, [a])).rows[0];
    const conc = (await d.pool.query(`SELECT coalesce(max(n)::float / NULLIF(sum(n), 0), 0) share FROM (SELECT count(*) n FROM idx_sales WHERE distributor = $1 AND status = 'settled' GROUP BY buyer) t`, [a])).rows[0].share;
    const by = (await d.pool.query(`SELECT campaign, count(*) FILTER (WHERE status='settled')::int purchases, coalesce(sum(commission_amount) FILTER (WHERE status='settled'),0) earned FROM idx_sales WHERE distributor = $1 GROUP BY campaign ORDER BY 3 DESC LIMIT 20`, [a])).rows;
    const recent = (await d.pool.query(`SELECT ${RJ} ${RFROM} WHERE s.distributor = $1 ORDER BY COALESCE(s.settled_at, s.opened_at) DESC LIMIT 20`, [a])).rows;
    // claims issued (off-chain, server-side record) vs sales that reached a payment (vault funded: settled, refunded or still held)
    const issued = (await d.pool.query(`SELECT count(*)::int n FROM claim_issuance WHERE distributor = $1`, [a])).rows[0].n;
    const paid = (await d.pool.query(`SELECT count(*)::int n FROM idx_sales WHERE distributor = $1 AND (gross > 0 OR vault_amount > 0)`, [a])).rows[0].n;
    cache(c);
    return c.json({
      distributor: a, decimals: d.decimals, disclosure: DISCLOSURE,
      // plain, checkable numbers instead of a composite "trust score"
      metrics: { eligiblePurchases: st.purchases, refunded: st.refunded, open: st.open, totalEarned: String(st.earned), referredVolume: String(st.volume), distinctBuyers: st.distinct_buyers, campaigns: st.campaigns, topBuyerShare: Number(Number(conc).toFixed(4)) },
      claims: { issued, paid }, byCampaign: by.map((r) => ({ campaign: r.campaign, purchases: r.purchases, earned: String(r.earned) })), recent: recent.map(receipt),
    });
  });

  /* ---------- platform ---------- */
  app.get("/stats", async (c) => {
    const t = (await d.pool.query(
      `SELECT (SELECT count(*)::int FROM idx_campaigns) campaigns, (SELECT count(*)::int FROM listings) listed,
              count(*) FILTER (WHERE s.status='settled')::int settled, count(*) FILTER (WHERE s.status='refunded')::int refunded, count(*) FILTER (WHERE s.status='open')::int open,
              coalesce(sum(s.gross) FILTER (WHERE s.status='settled'),0) volume, coalesce(sum(s.commission_amount) FILTER (WHERE s.status='settled'),0) commissions,
              coalesce(sum(s.fee_amount) FILTER (WHERE s.status='settled'),0) fees, coalesce(sum(s.gross) FILTER (WHERE s.status='refunded'),0) refunded_amount,
              count(DISTINCT s.buyer) FILTER (WHERE s.status='settled')::int distinct_buyers, count(DISTINCT s.distributor) FILTER (WHERE s.status='settled')::int distinct_distributors
         FROM idx_sales s`)).rows[0];
    const split = (await d.pool.query(
      `SELECT CASE WHEN l.campaign IS NULL THEN 'unlisted' WHEN l.is_sample THEN 'sample' ELSE 'listed' END kind, count(*)::int n, coalesce(sum(s.gross),0) volume
         FROM idx_sales s LEFT JOIN listings l ON l.campaign = s.campaign WHERE s.status = 'settled' GROUP BY 1`)).rows;
    const by = Object.fromEntries(split.map((r) => [r.kind, { settled: r.n, volume: String(r.volume) }]));
    const merchants = (await d.pool.query(`SELECT count(DISTINCT merchant)::int n FROM idx_campaigns`)).rows[0].n;
    const idx = (await d.pool.query(`SELECT last_synced_at, last_slot, last_error FROM idx_state WHERE id = 1`)).rows[0];
    cache(c);
    return c.json({
      cluster: d.cluster, programId: d.programId, decimals: d.decimals, disclosure: DISCLOSURE,
      protocol: await protocol().then((c) => (c ? { admin: c.admin.toBase58(), feeOwner: c.feeOwner.toBase58(), feeBps: c.feeBps, maxFeeBps: 500 } : null)),
      totals: { campaigns: t.campaigns, listedCampaigns: t.listed, merchants, settled: t.settled, refunded: t.refunded, open: t.open, volume: String(t.volume), commissionsPaid: String(t.commissions), protocolFees: String(t.fees), refundedAmount: String(t.refunded_amount), distinctBuyers: t.distinct_buyers, distinctDistributors: t.distinct_distributors },
      // honesty: demo volume is reported separately and never counted as market demand
      volumeBySource: { sample: by.sample ?? { settled: 0, volume: "0" }, listed: by.listed ?? { settled: 0, volume: "0" }, unlisted: by.unlisted ?? { settled: 0, volume: "0" } },
      index: { lastSyncedAt: iso(idx?.last_synced_at ?? null), ageSeconds: idx?.last_synced_at ? Math.max(0, now() - Math.floor(new Date(idx.last_synced_at).getTime() / 1000)) : null, lastSlot: idx?.last_slot ? Number(idx.last_slot) : null, lastError: idx?.last_error ?? null },
    });
  });

  /* ---------- merchant-signed listing ---------- */
  app.put("/campaigns/:address/listing", async (c) => {
    const a = c.req.param("address"); if (!isPk(a)) return bad(c, 400, "bad_request", "invalid address");
    let json: unknown; try { json = await c.req.json(); } catch { return bad(c, 400, "bad_request", "body must be JSON"); }
    const b = listingBody.safeParse(json);
    if (!b.success) return bad(c, 400, "bad_request", "invalid listing: " + b.error.issues.map((i) => i.path.join(".")).join(","));
    const l = b.data.listing as Listing;
    if (!httpsOnly(l.endpointUrl) || (l.website && !httpsOnly(l.website))) return bad(c, 400, "bad_url", "URLs must be https and must not embed credentials");
    let sig: Buffer; try { sig = Buffer.from(b.data.signature, "base64"); } catch { sig = Buffer.alloc(0); }
    const camp = await d.campaigns.get(new PublicKey(a));
    if (!camp) return bad(c, 404, "campaign_not_found", "no such campaign on-chain");
    // the merchant is read from the campaign ON-CHAIN: only the wallet that created the campaign may list it
    if (sig.length !== 64 || !verifyListing({ campaign: new PublicKey(a), listing: l, ts: b.data.ts }, sig, camp.merchant, now())) return c.json({ error: { code: "bad_signature", message: "listing must be signed by the campaign's merchant wallet and be fresh (60s)" } }, 401 as any);
    // signature was checked over the exact text sent; what we STORE and SERVE is the normalised form (no control/escape characters)
    const st = { ...l, name: clean(l.name), description: clean(l.description), route: clean(l.route), displayPrice: clean(l.displayPrice) };
    if (!st.name || !st.description || !st.route || !st.displayPrice) return bad(c, 400, "bad_request", "fields must contain visible text");
    await d.pool.query(
      `INSERT INTO listings (campaign, name, description, category, endpoint_url, route, display_price, website, is_sample, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (campaign) DO UPDATE SET name=$2, description=$3, category=$4, endpoint_url=$5, route=$6, display_price=$7, website=$8, is_sample=$9, updated_at=now()`,
      [a, st.name, st.description, st.category, st.endpointUrl, st.route, st.displayPrice, st.website ?? null, st.isSample]);
    return c.json({ ok: true, campaign: a, listing: st });
  });

  /* ---------- merchant-signed removal from the directory ---------- */
  app.delete("/campaigns/:address/listing", async (c) => {
    const a = c.req.param("address"); if (!isPk(a)) return bad(c, 400, "bad_request", "invalid address");
    let json: unknown; try { json = await c.req.json(); } catch { return bad(c, 400, "bad_request", "body must be JSON"); }
    const b = z.object({ ts: z.number().int(), signature: z.string().min(80).max(100) }).strict().safeParse(json);
    if (!b.success) return bad(c, 400, "bad_request", "invalid body");
    let sig: Buffer; try { sig = Buffer.from(b.data.signature, "base64"); } catch { sig = Buffer.alloc(0); }
    const camp = await d.campaigns.get(new PublicKey(a));
    if (!camp) return bad(c, 404, "campaign_not_found", "no such campaign on-chain");
    // merchant read from the chain, as for listing: only the wallet that created the campaign can remove it
    if (sig.length !== 64 || !verifyUnlist({ campaign: new PublicKey(a), ts: b.data.ts }, sig, camp.merchant, now())) return c.json({ error: { code: "bad_signature", message: "removal must be signed by the campaign's merchant wallet and be fresh (60s)" } }, 401 as any);
    const r = await d.pool.query("DELETE FROM listings WHERE campaign = $1", [a]);
    return c.json({ ok: true, campaign: a, removed: (r.rowCount ?? 0) > 0 }); // idempotent: removing an unlisted campaign is fine
  });

  /* ---------- index freshness ---------- */
  app.get("/index", async (c) => {
    const r = (await d.pool.query(`SELECT last_synced_at, last_slot, last_error, last_error_at, campaigns, sales FROM idx_state WHERE id = 1`)).rows[0];
    return c.json({ lastSyncedAt: iso(r?.last_synced_at ?? null), ageSeconds: r?.last_synced_at ? Math.max(0, now() - Math.floor(new Date(r.last_synced_at).getTime() / 1000)) : null, lastSlot: r?.last_slot ? Number(r.last_slot) : null, campaigns: r?.campaigns ?? 0, sales: r?.sales ?? 0, lastError: r?.last_error ?? null, lastErrorAt: iso(r?.last_error_at ?? null) });
  });
  return app;
}
