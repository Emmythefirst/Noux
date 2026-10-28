/**
 * Incremental vs full indexing on REAL devnet. Database A follows the chain by deltas, database B takes a fresh full snapshot at the end; the tables must match.
 *   docker exec noux-pg psql -U postgres -c "CREATE DATABASE noux_inc_a" -c "CREATE DATABASE noux_inc_b"
 *   set -a; . ../../.env; set +a; ACTIVITY="pnpm devnet-e2e" pnpm tsx scripts/indexer-incremental-devnet.ts
 * ACTIVITY is a shell command that creates real devnet activity between the two passes (devnet-e2e opens, pays, settles and refunds real sales).
 */
import { execSync } from "node:child_process";
import { Connection, PublicKey } from "@solana/web3.js";
import { idl } from "@noux/core";
import { createPool, migrate } from "../src/db";
import { syncAuto, syncOnce } from "../src/indexer/sync";
import { AnchorIndexerChain } from "../src/indexer/chain";

const base = "postgres://postgres:devonly@localhost:54329/";
const A = createPool(base + "noux_inc_a"), B = createPool(base + "noux_inc_b");
for (const p of [A, B]) { await migrate(p); await p.query("TRUNCATE idx_campaigns, idx_sales, listings, idx_state"); }
const conn = new Connection(process.env.RPC_URL!, "confirmed");
const chain = new AnchorIndexerChain(conn, new PublicKey((idl as any).address));
const dump = async (p: typeof A) => ({
  sales: (await p.query("SELECT address, campaign, status, gross::text g, merchant_amount::text m, commission_amount::text c, fee_amount::text f, vault_amount::text v, extract(epoch FROM settled_at)::bigint s FROM idx_sales ORDER BY address")).rows,
  campaigns: (await p.query("SELECT address, settled_count::text sc, refunded_count::text rc, commission_spent::text cs FROM idx_campaigns ORDER BY address")).rows,
});
const t = async <T,>(f: () => Promise<T>) => { const s = Date.now(); const v = await f(); return [v, Date.now() - s] as const; };

const [first, ms1] = await t(() => syncAuto(A, chain, { enrichLimit: 0 }));
console.log(`pass 1 (${first.mode}): ${first.sales} sales, ${first.campaigns} campaigns, ${ms1} ms`);
const [quiet, msq] = await t(() => syncAuto(A, chain, { enrichLimit: 0 }));
console.log(`pass 2 (${quiet.mode}) with no activity: checked ${quiet.touched} accounts, ${msq} ms`);
if (process.env.ACTIVITY) { console.log("running real devnet activity: " + process.env.ACTIVITY); execSync(process.env.ACTIVITY, { stdio: "ignore", env: process.env, timeout: 600_000 }); }
const [inc, msi] = await t(() => syncAuto(A, chain, { enrichLimit: 0 }));
console.log(`pass 3 (${inc.mode}) after the activity: checked ${inc.touched} accounts, ${inc.sales} sale rows fetched, ${msi} ms`);
const [full, msf] = await t(() => syncOnce(B, chain, { enrichLimit: 0 }));
console.log(`fresh full snapshot into B: ${full.sales} sales, ${msf} ms`);
const a = await dump(A), b = await dump(B);
const key = (r: any) => r.address, bm = new Map(b.sales.map((r: any) => [key(r), JSON.stringify(r)]));
const diffs = a.sales.filter((r: any) => bm.get(key(r)) !== JSON.stringify(r)).map((r: any) => key(r)).concat(b.sales.filter((r: any) => !a.sales.find((x: any) => key(x) === key(r))).map((r: any) => key(r)));
console.log(`sales A=${a.sales.length} B=${b.sales.length}; campaigns A=${a.campaigns.length} B=${b.campaigns.length}; differing sale rows: ${diffs.length}`);
console.log(JSON.stringify(a.campaigns) === JSON.stringify(b.campaigns) ? "campaign counters identical" : "CAMPAIGN COUNTERS DIFFER");
console.log(diffs.length === 0 ? "PASS: incremental == full on real devnet" : "DIFF: " + diffs.slice(0, 5).join(","));
process.exit(diffs.length === 0 ? 0 : 1);
