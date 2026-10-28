/**
 * Drain expired unpaid sales of a test mint with a production-tick keeper, and report how it copes with the backlog.
 *   set -a; . ../../.env; set +a; MINT=<test mint> pnpm tsx scripts/keeper-drain.ts
 */
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { idl } from "@noux/core";
import { AnchorKeeperChain, Keeper, MemorySeenStore } from "@noux/gateway";

process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
const TICK = Number(process.env.TICK ?? 30), mint = new PublicKey(process.env.MINT!);
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const conn = new Connection(process.env.RPC_URL!, "confirmed"), PROGRAM = new PublicKey((idl as any).address);
const chain = new AnchorKeeperChain({ connection: conn, programId: PROGRAM, mint, payer: deployer });
const keeper = new Keeper({ chain, seen: new MemorySeenStore() });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retry = async <T,>(f: () => Promise<T>) => { for (let i = 0; ; i++) { try { return await f(); } catch (e) { if (i >= 5) throw e; await sleep(2000 * (i + 1)); } } };
const mine = async () => { const open = await retry(() => chain.listOpenSales()); const bal = await retry(() => chain.vaultBalances(open.map((o) => o.sale))); return open.filter((o) => bal.get(o.sale) !== null && bal.get(o.sale) !== undefined).length; };
const sol0 = await conn.getBalance(deployer.publicKey), t0 = Date.now(); let left = await mine(); console.log(`open sales of this mint: ${left}; payer SOL ${(sol0 / 1e9).toFixed(4)}`);
const rows: { ms: number; closed: number; failed: number }[] = [];
while (left > 0 && Date.now() - t0 < 40 * 60_000) {
  const s = Date.now(); const r = await keeper.tick().catch((e) => ({ closed: [] as string[], failed: [{ sale: "*", error: String(e) }], waiting: 0, skipped: 0, settled: [] as string[] }));
  rows.push({ ms: Date.now() - s, closed: r.closed.length, failed: r.failed.length }); left = await mine();
  console.log(`tick @${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s: ${String(rows[rows.length - 1].ms).padStart(6)} ms | closed ${r.closed.length} | failed ${r.failed.length}${r.failed[0] ? " (" + r.failed[0].error.slice(0, 70) + ")" : ""} | still open ${left}`);
  if (left > 0) await sleep(Math.max(0, TICK * 1000 - (Date.now() - s)));
}
const sol1 = await conn.getBalance(deployer.publicKey);
console.log(`\ndrained: ${left === 0} in ${Math.round((Date.now() - t0) / 1000)} s over ${rows.length} ticks; slowest tick ${Math.max(...rows.map((r) => r.ms))} ms vs a ${TICK * 1000} ms interval; most closes per tick ${Math.max(...rows.map((r) => r.closed))}; avg ${(rows.reduce((a, r) => a + r.ms, 0) / Math.max(1, rows.reduce((a, r) => a + r.closed, 0))).toFixed(0)} ms per close`);
console.log(`payer SOL ${(sol0 / 1e9).toFixed(4)} -> ${(sol1 / 1e9).toFixed(4)} (rent returned: +${((sol1 - sol0) / 1e9).toFixed(4)})`);
process.exit(left === 0 ? 0 : 1);
