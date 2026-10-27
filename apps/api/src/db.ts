import pg from "pg";

export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS claim_issuance (
     id          BIGSERIAL PRIMARY KEY,
     campaign    TEXT        NOT NULL,
     distributor TEXT        NOT NULL,
     buyer       TEXT        NOT NULL,
     ip          TEXT        NOT NULL,
     price       NUMERIC     NOT NULL,
     nonce       TEXT        NOT NULL UNIQUE,
     expiry      TIMESTAMPTZ NOT NULL,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS claim_issuance_created ON claim_issuance (created_at)`,
  `CREATE INDEX IF NOT EXISTS claim_issuance_distributor ON claim_issuance (distributor, created_at)`,
  `CREATE INDEX IF NOT EXISTS claim_issuance_buyer ON claim_issuance (buyer, created_at)`,
  `CREATE INDEX IF NOT EXISTS claim_issuance_ip ON claim_issuance (ip, created_at)`,
  `CREATE INDEX IF NOT EXISTS claim_issuance_campaign ON claim_issuance (campaign, created_at)`,
];

import { SEEN_MIGRATION } from "./seen-store";
import { INDEXER_MIGRATIONS } from "./indexer/schema";
MIGRATIONS.push(SEEN_MIGRATION, ...INDEXER_MIGRATIONS);

export function createPool(url: string) { return new pg.Pool({ connectionString: url, max: 10 }); }
/** Serialised across processes: two instances starting together (a deploy overlap) must not race on CREATE TABLE IF NOT EXISTS. */
export async function migrate(pool: pg.Pool) {
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock(hashtext('noux-migrations'))");
    for (const sql of MIGRATIONS) await c.query(sql);
  } finally {
    try { await c.query("SELECT pg_advisory_unlock(hashtext('noux-migrations'))"); } catch { /* connection closing */ }
    c.release();
  }
}
