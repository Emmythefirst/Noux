import type pg from "pg";
import type { SeenStore } from "@noux/gateway";

export const SEEN_MIGRATION = `CREATE TABLE IF NOT EXISTS vault_first_seen (
  sale TEXT PRIMARY KEY,
  first_seen TIMESTAMPTZ NOT NULL
)`;

/** Keeper clock that survives restarts and is shared by every keeper instance. First writer wins. */
export class PgSeenStore implements SeenStore {
  constructor(private pool: pg.Pool) {}
  async get(sale: string) {
    const { rows } = await this.pool.query("SELECT extract(epoch FROM first_seen)::bigint AS t FROM vault_first_seen WHERE sale = $1", [sale]);
    return rows[0] ? Number(rows[0].t) : null;
  }
  async set(sale: string, t: number) {
    await this.pool.query("INSERT INTO vault_first_seen (sale, first_seen) VALUES ($1, to_timestamp($2)) ON CONFLICT (sale) DO NOTHING", [sale, t]);
  }
  async delete(sale: string) { await this.pool.query("DELETE FROM vault_first_seen WHERE sale = $1", [sale]); }
}
