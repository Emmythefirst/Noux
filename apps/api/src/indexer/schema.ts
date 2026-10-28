export const INDEXER_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS idx_campaigns (
     address TEXT PRIMARY KEY, merchant TEXT NOT NULL, mint TEXT NOT NULL, fee_owner TEXT NOT NULL, attribution_key TEXT NOT NULL,
     cluster TEXT NOT NULL, hold_secs INT NOT NULL, commission_bps INT NOT NULL, fee_bps INT NOT NULL,
     commission_budget NUMERIC NOT NULL, commission_spent NUMERIC NOT NULL, settled_count BIGINT NOT NULL, refunded_count BIGINT NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS idx_sales (
     address TEXT PRIMARY KEY, campaign TEXT NOT NULL, distributor TEXT NOT NULL, buyer TEXT NOT NULL, rent_payer TEXT NOT NULL,
     price NUMERIC NOT NULL, gross NUMERIC NOT NULL, merchant_amount NUMERIC NOT NULL, commission_amount NUMERIC NOT NULL, fee_amount NUMERIC NOT NULL,
     commission_bps INT NOT NULL, fee_bps INT NOT NULL, status TEXT NOT NULL,
     opened_at TIMESTAMPTZ NOT NULL, hold_until TIMESTAMPTZ NOT NULL, expiry TIMESTAMPTZ NOT NULL, settled_at TIMESTAMPTZ,
     open_sig TEXT, payment_sig TEXT, settle_sig TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `ALTER TABLE idx_sales ADD COLUMN IF NOT EXISTS vault_amount NUMERIC NOT NULL DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS idx_sales_campaign ON idx_sales (campaign, status)`,
  `CREATE INDEX IF NOT EXISTS idx_sales_distributor ON idx_sales (distributor)`,
  `CREATE INDEX IF NOT EXISTS idx_sales_buyer ON idx_sales (buyer)`,
  `CREATE INDEX IF NOT EXISTS idx_sales_settled ON idx_sales (settled_at DESC NULLS LAST)`,
  `CREATE TABLE IF NOT EXISTS listings (
     campaign TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
     endpoint_url TEXT NOT NULL, route TEXT NOT NULL, display_price TEXT NOT NULL, website TEXT, is_sample BOOLEAN NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS idx_state (
     id INT PRIMARY KEY, last_synced_at TIMESTAMPTZ, last_slot BIGINT, last_error TEXT, last_error_at TIMESTAMPTZ, campaigns INT NOT NULL DEFAULT 0, sales INT NOT NULL DEFAULT 0
   )`,
];
