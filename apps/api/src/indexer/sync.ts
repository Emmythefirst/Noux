import type pg from "pg";
import type { IndexerChain, SaleRow } from "./chain";

export interface SyncResult { campaigns: number; sales: number; enriched: number; slot: number }

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
export async function syncOnce(pool: pg.Pool, chain: IndexerChain, opts: { enrichLimit?: number } = {}): Promise<SyncResult> {
  const snap = await chain.snapshot(); // throws => nothing below runs
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    for (const k of snap.campaigns) {
      await c.query(
        `INSERT INTO idx_campaigns (address, merchant, mint, fee_owner, attribution_key, cluster, hold_secs, commission_bps, fee_bps, commission_budget, commission_spent, settled_count, refunded_count, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
         ON CONFLICT (address) DO UPDATE SET merchant=EXCLUDED.merchant, mint=EXCLUDED.mint, fee_owner=EXCLUDED.fee_owner, attribution_key=EXCLUDED.attribution_key, cluster=EXCLUDED.cluster,
           hold_secs=EXCLUDED.hold_secs, commission_bps=EXCLUDED.commission_bps, fee_bps=EXCLUDED.fee_bps, commission_budget=EXCLUDED.commission_budget, commission_spent=EXCLUDED.commission_spent,
           settled_count=EXCLUDED.settled_count, refunded_count=EXCLUDED.refunded_count, updated_at=now()
         WHERE EXCLUDED.settled_count >= idx_campaigns.settled_count AND EXCLUDED.refunded_count >= idx_campaigns.refunded_count AND EXCLUDED.commission_spent >= idx_campaigns.commission_spent`, // counters only grow: an older snapshot must not roll them back
        [k.address, k.merchant, k.mint, k.feeOwner, k.attributionKey, k.cluster, k.holdSecs, k.commissionBps, k.feeBps, k.commissionBudget, k.commissionSpent, k.settledCount, k.refundedCount],
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
    const vanished = [...known].filter(([a, st]) => st === "open" && !present.has(a)).map(([a]) => a);
    if (vanished.length) await c.query("DELETE FROM idx_sales WHERE status = 'open' AND address = ANY($1::text[])", [vanished]);
    await c.query(
      `INSERT INTO idx_state (id, last_synced_at, last_slot, last_error, last_error_at, campaigns, sales) VALUES (1, now(), $1, NULL, NULL, $2, $3)
       ON CONFLICT (id) DO UPDATE SET last_synced_at=now(), last_slot=$1, last_error=NULL, last_error_at=NULL, campaigns=$2, sales=$3`,
      [snap.slot, snap.campaigns.length, snap.sales.length],
    );
    await c.query("COMMIT");
  } catch (e) { try { await c.query("ROLLBACK"); } catch { /* already aborted */ } throw e; } finally { c.release(); }

  // lazily fill transaction signatures for finished sales: newest first, a bounded amount per sync, a few at a time; a sale that cannot be
  // read (or is not complete yet) backs off exponentially (1, 2, 4 ... 360 minutes) instead of occupying the front of the queue forever
  let enriched = 0;
  const { rows } = await pool.query(
    `SELECT s.address, c.mint FROM idx_sales s JOIN idx_campaigns c ON c.address = s.campaign
      WHERE s.status <> 'open' AND (s.settle_sig IS NULL OR s.open_sig IS NULL) AND (s.enrich_next IS NULL OR s.enrich_next <= now())
      ORDER BY s.settled_at DESC NULLS LAST LIMIT $1`, [opts.enrichLimit ?? 30]);
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
  return { campaigns: snap.campaigns.length, sales: snap.sales.length, enriched, slot: snap.slot };
}

export function startIndexerLoop(o: { pool: pg.Pool; chain: IndexerChain; intervalSeconds: number; log?: (m: string) => void }): () => void {
  const log = o.log ?? ((m: string) => console.log(m));
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        const r = await syncOnce(o.pool, o.chain);
        log(`indexer: ${r.campaigns} campaigns, ${r.sales} sales, +${r.enriched} sig lookups @slot ${r.slot}`);
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
