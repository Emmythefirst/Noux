import type pg from "pg";
import type { IndexerChain } from "./chain";

export interface SyncResult { campaigns: number; sales: number; enriched: number; slot: number }

/**
 * One idempotent snapshot sync. On-chain accounts are the source of truth:
 *  - everything is upserted inside ONE transaction; a failed fetch changes nothing;
 *  - sales that vanished on-chain (unpaid + closed by close_expired_sale) are removed;
 *  - transaction signatures (open / payment / settle) are filled in lazily, a few per sync, and never overwritten.
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
           settled_count=EXCLUDED.settled_count, refunded_count=EXCLUDED.refunded_count, updated_at=now()`,
        [k.address, k.merchant, k.mint, k.feeOwner, k.attributionKey, k.cluster, k.holdSecs, k.commissionBps, k.feeBps, k.commissionBudget, k.commissionSpent, k.settledCount, k.refundedCount],
      );
    }
    for (const x of snap.sales) {
      await c.query(
        `INSERT INTO idx_sales (address, campaign, distributor, buyer, rent_payer, price, gross, merchant_amount, commission_amount, fee_amount, commission_bps, fee_bps, status, opened_at, hold_until, expiry, settled_at, vault_amount, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,to_timestamp($14),to_timestamp($15),to_timestamp($16),CASE WHEN $17::bigint IS NULL THEN NULL ELSE to_timestamp($17::bigint) END, $18, now())
         ON CONFLICT (address) DO UPDATE SET campaign=EXCLUDED.campaign, distributor=EXCLUDED.distributor, buyer=EXCLUDED.buyer, rent_payer=EXCLUDED.rent_payer, price=EXCLUDED.price, gross=EXCLUDED.gross,
           merchant_amount=EXCLUDED.merchant_amount, commission_amount=EXCLUDED.commission_amount, fee_amount=EXCLUDED.fee_amount, commission_bps=EXCLUDED.commission_bps, fee_bps=EXCLUDED.fee_bps,
           status=EXCLUDED.status, opened_at=EXCLUDED.opened_at, hold_until=EXCLUDED.hold_until, expiry=EXCLUDED.expiry, settled_at=EXCLUDED.settled_at, vault_amount=EXCLUDED.vault_amount, updated_at=now()`,
        [x.address, x.campaign, x.distributor, x.buyer, x.rentPayer, x.price, x.gross, x.merchantAmount, x.commissionAmount, x.feeAmount, x.commissionBps, x.feeBps, x.status, x.openedAt, x.holdUntil, x.expiry, x.settledAt, x.vaultAmount],
      );
    }
    await c.query("DELETE FROM idx_sales WHERE NOT (address = ANY($1::text[]))", [snap.sales.map((s) => s.address)]);
    await c.query(
      `INSERT INTO idx_state (id, last_synced_at, last_slot, last_error, last_error_at, campaigns, sales) VALUES (1, now(), $1, NULL, NULL, $2, $3)
       ON CONFLICT (id) DO UPDATE SET last_synced_at=now(), last_slot=$1, last_error=NULL, last_error_at=NULL, campaigns=$2, sales=$3`,
      [snap.slot, snap.campaigns.length, snap.sales.length],
    );
    await c.query("COMMIT");
  } catch (e) { try { await c.query("ROLLBACK"); } catch { /* already aborted */ } throw e; } finally { c.release(); }

  // lazily fill transaction signatures for finished sales (bounded RPC work per sync)
  let enriched = 0;
  const { rows } = await pool.query(
    `SELECT s.address, c.mint FROM idx_sales s JOIN idx_campaigns c ON c.address = s.campaign
      WHERE s.status <> 'open' AND (s.settle_sig IS NULL OR s.open_sig IS NULL) ORDER BY s.settled_at DESC NULLS LAST LIMIT $1`, [opts.enrichLimit ?? 8]);
  for (const r of rows) {
    try {
      const sigs = (await chain.signatures(r.address, 20)).filter((x) => !x.failed);
      if (sigs.length === 0) continue;
      const openSig = sigs[sigs.length - 1].signature;               // oldest write to the sale account = open_sale
      const settleSig = sigs.length > 1 ? sigs[0].signature : null;   // newest = settle_sale / refund_sale
      const vault = (await chain.signatures(chain.vaultOf(r.address, r.mint), 20)).filter((x) => !x.failed);
      const payment = vault.find((x) => x.signature !== openSig && x.signature !== settleSig)?.signature ?? null; // the x402 transfer into the vault
      await pool.query(`UPDATE idx_sales SET open_sig = COALESCE(open_sig, $2), settle_sig = COALESCE(settle_sig, $3), payment_sig = COALESCE(payment_sig, $4) WHERE address = $1`, [r.address, openSig, settleSig, payment]);
      enriched++;
    } catch { /* RPC trouble: try again next sync */ }
  }
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
