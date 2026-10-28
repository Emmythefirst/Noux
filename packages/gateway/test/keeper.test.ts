import { describe, it, expect } from "vitest";
import { Keeper, MemorySeenStore, type KeeperChain, type OpenSale } from "../src";

function world() {
  let t = 1_000_000;
  const sales = new Map<string, OpenSale>(); const bal = new Map<string, bigint | null>(); const settled: string[] = [], closed: string[] = [];
  const failSettle = new Set<string>();
  const chain: KeeperChain = {
    listOpenSales: async () => [...sales.values()],
    vaultBalance: async (s) => (bal.has(s) ? bal.get(s)! : null),
    settle: async (s) => { if (failSettle.has(s)) throw new Error("rpc boom"); settled.push(s); sales.delete(s); bal.set(s, null); return "sig"; },
    closeExpired: async (s) => { closed.push(s); sales.delete(s); bal.set(s, null); return "sig"; },
  };
  const add = (id: string, o: Partial<OpenSale> = {}, balance: bigint | null = 0n) => { sales.set(id, { sale: id, price: 100n, holdSecs: 15, holdUntil: t + 15, expiry: t + 600, ...o }); bal.set(id, balance); };
  return { chain, add, bal, sales, settled, closed, failSettle, now: () => t, advance: (s: number) => { t += s; }, set: (v: number) => { t = v; } };
}
const mk = (w: ReturnType<typeof world>, seen = new MemorySeenStore()) => ({ k: new Keeper({ chain: w.chain, seen, now: w.now }), seen });

describe("keeper hold", () => {
  it("waits the FULL hold from first sight of the funded vault, not from sale open", async () => {
    const w = world(); w.add("A", { holdUntil: w.now() + 15 }, 0n); const { k } = mk(w);
    w.advance(100); // sale opened long ago (on-chain floor long passed) but unpaid until now
    expect((await k.tick()).settled).toEqual([]);
    w.bal.set("A", 100n); // payment lands at t=+100
    expect((await k.tick()).waiting).toBe(1); // first seen funded now: clock starts
    w.advance(14); expect((await k.tick()).settled).toEqual([]);
    w.advance(1); expect((await k.tick()).settled).toEqual(["A"]);
  });
  it("also respects the on-chain floor (holdUntil) even if first-seen hold elapsed", async () => {
    const w = world(); w.add("A", { holdSecs: 5, holdUntil: w.now() + 60 }, 100n); const { k } = mk(w);
    await k.tick(); w.advance(10); expect((await k.tick()).settled).toEqual([]);
    w.advance(50); expect((await k.tick()).settled).toEqual(["A"]);
  });
  it("first-seen survives a keeper restart (persistent store)", async () => {
    const w = world(); w.add("A", {}, 100n); const store = new MemorySeenStore();
    await new Keeper({ chain: w.chain, seen: store, now: w.now }).tick();
    w.advance(15);
    const restarted = new Keeper({ chain: w.chain, seen: store, now: w.now });
    expect((await restarted.tick()).settled).toEqual(["A"]);
  });
  it("a vault emptied (refunded) loses its clock; re-funding restarts the full hold", async () => {
    const w = world(); w.add("A", {}, 100n); const { k, seen } = mk(w);
    await k.tick(); w.advance(10); w.bal.set("A", 0n); await k.tick();
    expect(await seen.get("A")).toBeNull();
    w.bal.set("A", 100n); w.advance(10); await k.tick(); // refunded then re-funded at t0+20
    w.advance(14); expect((await k.tick()).settled).toEqual([]);
    w.advance(1); expect((await k.tick()).settled).toEqual(["A"]);
  });
  it("an underfunded vault is never settled", async () => {
    const w = world(); w.add("A", {}, 99n); const { k } = mk(w);
    for (let i = 0; i < 5; i++) { w.advance(100); expect((await k.tick()).settled).toEqual([]); }
  });
});

describe("keeper housekeeping", () => {
  it("closes expired unpaid sales (rent back) but settles, not closes, an expired funded one", async () => {
    const w = world(); w.add("UNPAID", { expiry: w.now() + 10 }, 0n); w.add("PAID", { expiry: w.now() + 10 }, 100n); const { k } = mk(w);
    await k.tick(); w.advance(30);
    const r = await k.tick();
    expect(r.closed).toEqual(["UNPAID"]); expect(r.settled).toEqual(["PAID"]);
  });
  it("does not close an unexpired unpaid sale", async () => {
    const w = world(); w.add("U", {}, 0n); const { k } = mk(w);
    w.advance(100); expect((await k.tick()).closed).toEqual([]);
  });
  it("is idempotent: a second tick after settling does nothing", async () => {
    const w = world(); w.add("A", {}, 100n); const { k } = mk(w);
    await k.tick(); w.advance(15); expect((await k.tick()).settled).toEqual(["A"]);
    const again = await k.tick(); expect(again.settled).toEqual([]); expect(w.settled).toEqual(["A"]);
  });
  it("one failing sale does not block the others, and is retried next tick", async () => {
    const w = world(); w.add("BAD", {}, 100n); w.add("GOOD", {}, 100n); w.failSettle.add("BAD"); const { k } = mk(w);
    await k.tick(); w.advance(15);
    const r = await k.tick();
    expect(r.settled).toEqual(["GOOD"]); expect(r.failed.map((f) => f.sale)).toEqual(["BAD"]);
    w.failSettle.delete("BAD"); w.advance(1); expect((await k.tick()).settled).toEqual(["BAD"]);
  });
  it("a listing failure is reported, not thrown", async () => {
    const w = world(); const k = new Keeper({ chain: { ...w.chain, listOpenSales: async () => { throw new Error("rpc down"); } }, seen: new MemorySeenStore(), now: w.now });
    expect((await k.tick()).failed[0].sale).toBe("*");
  });
});

describe("keeper reads vault balances in batches", () => {
  function batched() {
    const w = world(); let singles = 0, batches = 0, failBatch = false;
    (w.chain as any).vaultBalance = async (s: string) => { singles++; return w.bal.has(s) ? w.bal.get(s)! : null; };
    (w.chain as any).vaultBalances = async (ids: string[]) => { batches++; if (failBatch) throw new Error("rpc down"); return new Map(ids.map((i) => [i, w.bal.has(i) ? w.bal.get(i)! : null])); };
    return { w, counts: () => ({ singles, batches }), fail: (v: boolean) => { failBatch = v; } };
  }
  it("300 open sales cost one batched read, not 300 single reads, and behave exactly as before", async () => {
    const { w, counts } = batched();
    for (let i = 0; i < 300; i++) w.add("S" + i, { holdSecs: 0, holdUntil: w.now() - 1 }, i % 2 ? 100n : 0n);
    const { k } = mk(w); await k.tick(); // first sight of the funded ones: clock starts (holdSecs 0 => settle immediately on the same tick)
    expect(counts().singles).toBe(0); expect(counts().batches).toBe(1);
    expect(w.settled.length).toBe(150); // only the funded half
  });
  it("if the batch read fails the keeper falls back to per-sale reads (nothing is skipped)", async () => {
    const { w, counts, fail } = batched(); fail(true);
    for (let i = 0; i < 5; i++) w.add("S" + i, { holdSecs: 0, holdUntil: w.now() - 1 }, 100n);
    const { k } = mk(w); const r = await k.tick();
    expect(counts().singles).toBe(5); expect(r.settled.length).toBe(5);
  });
  it("a vault missing from the batch is treated as gone (skipped), like a single read returning null", async () => {
    const { w } = batched(); w.add("A", {}, 100n); w.add("B", {}, 100n); w.bal.set("B", null);
    const { k } = mk(w); const r = await k.tick(); expect(r.skipped).toBe(1); expect(r.waiting).toBe(1);
  });
});
