/**
 * Settlement keeper (replaces spike/sweeper.mjs).
 *
 * Rule (owner's tweak): a vault is settled by the keeper only after it has been seen FUNDED for the whole hold.
 * The on-chain hold counts from sale OPEN; that is only a floor (the program cannot see when payment arrived), so
 * the keeper measures from the first time it observed money in the vault. The merchant can still settle sooner.
 *
 * Idempotent and restart-safe (first-seen times live in a SeenStore); errors are isolated per sale.
 */
export interface OpenSale {
  sale: string; price: bigint; /** seconds */ holdSecs: number; /** on-chain floor: opened_at + hold */ holdUntil: number; expiry: number;
}
export interface KeeperChain {
  listOpenSales(): Promise<OpenSale[]>;
  /** Vault token balance, or null if the vault no longer exists. */
  vaultBalance(sale: string): Promise<bigint | null>;
  /** Optional batch form (one RPC call per ~100 sales instead of one per sale). Missing entries mean the vault does not exist. */
  vaultBalances?(sales: string[]): Promise<Map<string, bigint | null>>;
  settle(sale: string): Promise<string>;
  closeExpired(sale: string): Promise<string>;
}
export interface SeenStore {
  get(sale: string): Promise<number | null>;
  set(sale: string, firstSeenSec: number): Promise<void>;
  delete(sale: string): Promise<void>;
}
export class MemorySeenStore implements SeenStore {
  m = new Map<string, number>();
  async get(s: string) { return this.m.get(s) ?? null; }
  async set(s: string, t: number) { this.m.set(s, t); }
  async delete(s: string) { this.m.delete(s); }
}

export interface TickResult { settled: string[]; closed: string[]; waiting: number; skipped: number; failed: { sale: string; error: string }[] }

/** Runs `fn` over `items` with at most `limit` in flight; results come back in input order. `fn` must not throw. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } }));
  return out;
}

export class Keeper {
  /** `concurrency`: transactions in flight at once. A backlog of expired sales used to be closed one by one (about 4 s each on devnet: 120 sales = one 485 s tick). */
  constructor(private o: { chain: KeeperChain; seen: SeenStore; now?: () => number; concurrency?: number; log?: (m: string, d?: unknown) => void }) {}
  private now() { return (this.o.now ?? (() => Math.floor(Date.now() / 1000)))(); }

  async tick(): Promise<TickResult> {
    const r: TickResult = { settled: [], closed: [], waiting: 0, skipped: 0, failed: [] };
    const now = this.now();
    let sales: OpenSale[];
    try { sales = await this.o.chain.listOpenSales(); } catch (e) { r.failed.push({ sale: "*", error: String((e as Error).message).slice(0, 160) }); return r; }
    // one batched read for all open sales when the chain adapter supports it; a failure falls back to per-sale reads
    let batch: Map<string, bigint | null> | null = null;
    if (this.o.chain.vaultBalances && sales.length > 1) { try { batch = await this.o.chain.vaultBalances(sales.map((x) => x.sale)); } catch { batch = null; } }

    // 1. decide (reads only): which sales need a transaction
    const settles: string[] = [], closes: string[] = [];
    for (const s of sales) {
      try {
        const bal = batch ? (batch.get(s.sale) ?? null) : await this.o.chain.vaultBalance(s.sale);
        if (bal === null) { await this.o.seen.delete(s.sale); r.skipped++; continue; }
        if (bal < s.price) {
          await this.o.seen.delete(s.sale); // not (or no longer) funded: the clock must restart if it is funded again
          if (now > s.expiry && bal === 0n) closes.push(s.sale); else r.skipped++;
          continue;
        }
        let first = await this.o.seen.get(s.sale);
        if (first === null) { first = now; await this.o.seen.set(s.sale, first); }
        // Both conditions: our own observed-funded hold AND the on-chain floor (otherwise the program would reject).
        if (now >= first + s.holdSecs && now >= s.holdUntil) settles.push(s.sale); else r.waiting++;
      } catch (e) { r.failed.push({ sale: s.sale, error: String((e as Error).message).slice(0, 160) }); }
    }

    // 2. act, a few at a time: settlements first (money waiting to be split matters more than rent waiting to be reclaimed)
    const limit = Math.max(1, this.o.concurrency ?? 6);
    const done = await mapLimit(settles, limit, async (sale) => {
      try { await this.o.chain.settle(sale); await this.o.seen.delete(sale); return { sale, ok: true as const }; }
      catch (e) { return { sale, ok: false as const, error: String((e as Error).message).slice(0, 160) }; }
    });
    for (const d of done) d.ok ? r.settled.push(d.sale) : r.failed.push({ sale: d.sale, error: d.error });
    const shut = await mapLimit(closes, limit, async (sale) => {
      try { await this.o.chain.closeExpired(sale); return { sale, ok: true as const }; }
      catch (e) { return { sale, ok: false as const, error: String((e as Error).message).slice(0, 160) }; }
    });
    for (const d of shut) d.ok ? r.closed.push(d.sale) : r.failed.push({ sale: d.sale, error: d.error });
    return r;
  }
}
