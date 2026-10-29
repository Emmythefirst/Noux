import type pg from "pg";
import type { IndexerChain, SaleRow, Snapshot } from "./chain";

export interface SyncResult { campaigns: number; sales: number; enriched: number; slot: number; mode?: "full" | "incremental"; touched?: number }

const UPSERT_BATCH = 500;
const ENRICH_CONCURRENCY = 5;

/**
 * One idempotent snapshot sync. On-chain accounts are the source of truth:
 *  - everything is written inside ONE transaction; a failed fetch changes nothing;
 *  - FINISHED sales (settled / refunded) are permanent on-chain receipts and never change, so they are not rewritten: only new and
 *    still-open sales are upserted, in batches. (Rewriting every sale one row at a time cost ~1 ms per sale per sync, even with no change.)
 *  - open sales that vanished on-chain (unpaid + closed by close_expired_sale) are removed;
 *  - transaction signatures (open / payment / settle) are filled in lazily, a bounded number per sync, with per-sale backoff so sales
 *    that cannot be read (yet) never block the others.
 */
export async function syncOnce(pool: pg.Pool, chain: IndexerChain, opts: { enrichLimit?: number; now?: () => number } = {}): Promise<SyncResult> {
  // read the transaction cursor BEFORE the snapshot: anything that happens after it is seen again by the next incremental pass
  const head = chain.incremental ? await chain.incremental.head().catch(() => null) : null;
  const snap = await chain.snapshot(); // throws => nothing below runs
  await apply(pool, snap, null, { mode: "full", cursor: head, fullAtSec: (opts.now ?? (() => Math.floor(Date.now() / 1000)))() });
  const enriched = await enrich(pool, chain, opts.enrichLimit);
  return { campaigns: snap.campaigns.length, sales: snap.sales.length, enriched, slot: snap.slot, mode: "full" };
}

/**
 * Writes one view of the chain in ONE transaction. `gone` is null for a full snapshot (every open sale missing from it has vanished),
 * or the explicit list of sale accounts that no longer exist (incremental: absence from a partial list means nothing).
 */
async function apply(pool: pg.Pool, snap: Snapshot, gone: string[] | null, o: { mode: "full" | "incremental"; cursor: string | null; fullAtSec: number | null }): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    for (const k of snap.campaigns) {
      await c.query(
        `INSERT INTO idx_campaigns (address, merchant, mint, fee_owner, attribution_key, cluster, hold_secs, commission_bps, fee_bps, commission_budget, commission_spent, settled_count, refunded_count, state, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
         ON CONFLICT (address) DO UPDATE SET merchant=EXCLUDED.merchant, mint=EXCLUDED.mint, fee_owner=EXCLUDED.fee_owner, attribution_key=EXCLUDED.attribution_key, cluster=EXCLUDED.cluster,
           hold_secs=EXCLUDED.hold_secs, commission_bps=EXCLUDED.commission_bps, fee_bps=EXCLUDED.fee_bps, commission_budget=EXCLUDED.commission_budget, commission_spent=EXCLUDED.commission_spent,
           settled_count=EXCLUDED.settled_count, refunded_count=EXCLUDED.refunded_count, state=EXCLUDED.state, updated_at=now()
         WHERE EXCLUDED.settled_count >= idx_campaigns.settled_count AND EXCLUDED.refunded_count >= idx_campaigns.refunded_count AND EXCLUDED.commission_spent >= idx_campaigns.commission_spent`, // counters only grow: an older snapshot must not roll them back
        [k.address, k.merchant, k.mint, k.feeOwner, k.attributionKey, k.cluster, k.holdSecs, k.commissionBps, k.feeBps, k.commissionBudget, k.commissionSpent, k.settledCount, k.refundedCount, k.state ?? "active"],
      );
    }
    const known = new Map<string, string>((await c.query("SELECT address, status FROM idx_sales")).rows.map((r) => [r.address, r.status]));
    const toWrite = snap.sales.filter((x) => { const st = known.get(x.address); return st === undefined || st === "open"; }); // new, or open and possibly changed
    for (let i = 0; i < toWrite.length; i += UPSERT_BATCH) {
      const b = toWrite.slice(i, i + UPSERT_BATCH), col = <T,>(f: (x: SaleRow) => T) => b.map(f);
      await c.query(
        `INSERT INTO idx_sales (address, campaign, distributor, buyer, rent_payer, price, gross, merchant_amount, commission_amount, fee_amount, commission_bps, fee_bps, status, opened_at, hold_until, expiry, settled_at, vault_amount, updated_at)
         SELECT a, ca, d, bu, rp, pr, gr, ma, co, fe, cb, fb, st, to_timestamp(oa), to_timestamp(hu), to_timestamp(ex), CASE WHEN sa IS NULL THEN NULL ELSE to_timestamp(sa) END, va, now()
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[], $10::numeric[], $11::int[], $12::int[], $13::text[], $14::bigint[], $15::bigint[], $16::bigint[], $17::bigint[], $18::numeric[])
                AS t(a, ca, d, bu, rp, pr, gr, ma, co, fe, cb, fb, st, oa, hu, ex, sa, va)
         ON CONFLICT (address) DO UPDATE SET campaign=EXCLUDED.campaign, distributor=EXCLUDED.distributor, buyer=EXCLUDED.buyer, rent_payer=EXCLUDED.rent_payer, price=EXCLUDED.price, gross=EXCLUDED.gross,
           merchant_amount=EXCLUDED.merchant_amount, commission_amount=EXCLUDED.commission_amount, fee_amount=EXCLUDED.fee_amount, commission_bps=EXCLUDED.commission_bps, fee_bps=EXCLUDED.fee_bps,
           status=EXCLUDED.status, opened_at=EXCLUDED.opened_at, hold_until=EXCLUDED.hold_until, expiry=EXCLUDED.expiry, settled_at=EXCLUDED.settled_at, vault_amount=EXCLUDED.vault_amount, updated_at=now()
         WHERE idx_sales.status = 'open'`, // a settled or refunded receipt is final on-chain: a stale or overlapping snapshot must not change it (also enforced here against races)
        [col((x) => x.address), col((x) => x.campaign), col((x) => x.distributor), col((x) => x.buyer), col((x) => x.rentPayer), col((x) => x.price), col((x) => x.gross), col((x) => x.merchantAmount),
         col((x) => x.commissionAmount), col((x) => x.feeAmount), col((x) => x.commissionBps), col((x) => x.feeBps), col((x) => x.status), col((x) => x.openedAt), col((x) => x.holdUntil), col((x) => x.expiry),
         col((x) => x.settledAt), col((x) => x.vaultAmount)],
      );
    }
    // only OPEN sales can vanish (unpaid ones closed by close_expired_sale). Settled/refunded Sale accounts are permanent receipts, so a
    // short or empty RPC answer must never wipe them.
    const present = new Set(snap.sales.map((x) => x.address));
    const vanished = gone === null ? [...known].filter(([a, st]) => st === "open" && !present.has(a)).map(([a]) => a) : gone.filter((a) => known.get(a) === "open");
    if (vanished.length) await c.query("DELETE FROM idx_sales WHERE status = 'open' AND address = ANY($1::text[])", [vanished]);
    const total = (await c.query("SELECT (SELECT count(*) FROM idx_campaigns)::int AS camps, (SELECT count(*) FROM idx_sales)::int AS sales")).rows[0];
    await c.query(
      `INSERT INTO idx_state (id, last_synced_at, last_slot, last_error, last_error_at, campaigns, sales, last_mode, cursor_sig, last_full_at)
       VALUES (1, now(), $1, NULL, NULL, $2, $3, $4, $5, CASE WHEN $6::bigint IS NULL THEN NULL ELSE to_timestamp($6::bigint) END)
       ON CONFLICT (id) DO UPDATE SET last_synced_at=now(), last_slot=$1, last_error=NULL, last_error_at=NULL, campaigns=$2, sales=$3, last_mode=$4,
         cursor_sig=COALESCE($5, idx_state.cursor_sig), last_full_at=CASE WHEN $6::bigint IS NULL THEN idx_state.last_full_at ELSE to_timestamp($6::bigint) END`,
      [snap.slot, total.camps, total.sales, o.mode, o.cursor, o.fullAtSec],
    );
    await c.query("COMMIT");
  } catch (e) { try { await c.query("ROLLBACK"); } catch { /* already aborted */ } throw e; } finally { c.release(); }
}

async function enrich(pool: pg.Pool, chain: IndexerChain, limit?: number): Promise<number> {

  // lazily fill transaction signatures for finished sales: newest first, a bounded amount per sync, a few at a time; a sale that cannot be
  // read (or is not complete yet) backs off exponentially (1, 2, 4 ... 360 minutes) instead of occupying the front of the queue forever
  let enriched = 0;
  const { rows } = await pool.query(
    `SELECT s.address, c.mint FROM idx_sales s JOIN idx_campaigns c ON c.address = s.campaign
      WHERE s.status <> 'open' AND (s.settle_sig IS NULL OR s.open_sig IS NULL) AND (s.enrich_next IS NULL OR s.enrich_next <= now())
      ORDER BY s.settled_at DESC NULLS LAST LIMIT $1`, [limit ?? 30]);
  const backoff = (address: string) => pool.query(`UPDATE idx_sales SET enrich_tries = enrich_tries + 1, enrich_next = now() + make_interval(mins => LEAST(power(2, enrich_tries)::int, 360)) WHERE address = $1`, [address]);
  const enrichOne = async (r: { address: string; mint: string }) => {
    try {
      const sigs = (await chain.signatures(r.address, 20)).filter((x) => !x.failed);
      if (sigs.length === 0) { await backoff(r.address); return; }
      const openSig = sigs[sigs.length - 1].signature;               // oldest write to the sale account = open_sale
      const settleSig = sigs.length > 1 ? sigs[0].signature : null;   // newest = settle_sale / refund_sale
      const vault = (await chain.signatures(chain.vaultOf(r.address, r.mint), 20)).filter((x) => !x.failed);
      const payment = vault.find((x) => x.signature !== openSig && x.signature !== settleSig)?.signature ?? null; // the x402 transfer into the vault
      await pool.query(`UPDATE idx_sales SET open_sig = COALESCE(open_sig, $2), settle_sig = COALESCE(settle_sig, $3), payment_sig = COALESCE(payment_sig, $4) WHERE address = $1`, [r.address, openSig, settleSig, payment]);
      if (settleSig === null) await backoff(r.address); else enriched++; // incomplete (the settlement may not be indexed by the node yet): look again later
    } catch { await backoff(r.address).catch(() => {}); /* RPC trouble: try again later */ }
  };
  for (let i = 0; i < rows.length; i += ENRICH_CONCURRENCY) await Promise.all(rows.slice(i, i + ENRICH_CONCURRENCY).map(enrichOne));
  return enriched;
}

/** Cursor = the newest transaction at least this old: everything newer is looked at again next pass, so a transaction the node indexes late is never skipped. */
const CURSOR_SAFETY_SECS = 90;
/** A full snapshot at least this often: catches anything the delta path cannot see (an account changed by a CPI the cursor missed, an RPC that dropped a transaction). */
export const FULL_EVERY_SECS = 6 * 3600;

/**
 * Incremental pass: new program transactions -> the Sale accounts they carried, plus every sale the database still has OPEN (a payment into
 * a vault is a token transfer, not a program transaction, so open sales are always refreshed). Campaigns are few and always re-read.
 * Falls back to a full snapshot (returns null) when there is no usable cursor or the delta is too large.
 */
async function syncIncremental(pool: pg.Pool, chain: IndexerChain, inc: NonNullable<IndexerChain["incremental"]>, cursor: string, now: number, enrichLimit?: number): Promise<SyncResult | null> {
  const { txs, overflow } = await inc.txsSince(cursor);
  if (overflow) return null;
  const campaigns = await inc.campaigns();
  const mintOf = new Map(campaigns.map((k) => [k.address, k.mint]));
  const programKeys = new Set(campaigns.map((k) => k.address)); // campaign accounts are re-read in full above: skip them as sale candidates
  const open = (await pool.query("SELECT address FROM idx_sales WHERE status = 'open'")).rows.map((r) => r.address as string);
  const candidates = new Set<string>(open);
  for (const t of txs) for (const k of t.keys) if (!programKeys.has(k)) candidates.add(k);
  const { sales, missing } = await inc.sales([...candidates], mintOf);
  const slot = await inc.slot();
  // the new cursor: newest transaction that is already old enough; otherwise keep the one we have
  const safe = [...txs].reverse().find((t) => t.blockTime !== null && t.blockTime <= now - CURSOR_SAFETY_SECS);
  await apply(pool, { slot, campaigns, sales }, missing, { mode: "incremental", cursor: safe?.signature ?? null, fullAtSec: null });
  const enriched = await enrich(pool, chain, enrichLimit);
  return { campaigns: campaigns.length, sales: sales.length, enriched, slot, mode: "incremental", touched: candidates.size };
}

/** What the loop runs: incremental when the chain supports it and a recent full snapshot + cursor exist, otherwise a full snapshot. */
export async function syncAuto(pool: pg.Pool, chain: IndexerChain, opts: { enrichLimit?: number; now?: () => number; fullEverySecs?: number; forceFull?: boolean } = {}): Promise<SyncResult> {
  const inc = chain.incremental;
  const now = (opts.now ?? (() => Math.floor(Date.now() / 1000)))();
  if (inc && !opts.forceFull) {
    const st = (await pool.query("SELECT cursor_sig, extract(epoch FROM last_full_at)::bigint AS full_at FROM idx_state WHERE id = 1")).rows[0];
    const fresh = st?.cursor_sig && st.full_at && now - Number(st.full_at) < (opts.fullEverySecs ?? FULL_EVERY_SECS);
    if (fresh) { try { const r = await syncIncremental(pool, chain, inc, st.cursor_sig, now, opts.enrichLimit); if (r) return r; } catch (e) { console.log("indexer: incremental pass failed, falling back to a full snapshot: " + String((e as Error).message).slice(0, 160)); } }
  }
  return syncOnce(pool, chain, { ...opts, now: () => now });
}

export function startIndexerLoop(o: { pool: pg.Pool; chain: IndexerChain; intervalSeconds: number; forceFull?: boolean; log?: (m: string) => void }): () => void {
  const log = o.log ?? ((m: string) => console.log(m));
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        const r = await syncAuto(o.pool, o.chain, { forceFull: o.forceFull });
        log(`indexer[${r.mode}]: ${r.campaigns} campaigns, ${r.sales} sales${r.touched !== undefined ? ` (${r.touched} accounts checked)` : ""}, +${r.enriched} sig lookups @slot ${r.slot}`);
      } catch (e) {
        const msg = String((e as Error).message).slice(0, 200);
        log(`indexer error: ${msg}`);
        await o.pool.query(`INSERT INTO idx_state (id, last_error, last_error_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET last_error=$1, last_error_at=now()`, [msg]).catch(() => {});
      }
      await new Promise((res) => setTimeout(res, o.intervalSeconds * 1000));
    }
  })();
  return () => { stopped = true; };
}
