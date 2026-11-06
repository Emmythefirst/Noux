import { describe, it, expect } from "vitest";
import { singlePrice, splitOf, earnPerSale, runwaySales, isOpen, directoryTotals, refundText, sortItems, matches, categoryCounts, type Filters } from "../src/lib/directory";
import { projectedSplit } from "../src/lib/format";
import type { Campaign } from "../src/lib/api";

const mk = (o: Partial<Campaign> & { address: string }, price = "$0.10", over: Partial<Campaign["listing"] & object> = {}): Campaign => ({
  merchant: "M", mint: "X", decimals: 6, cluster: "devnet", commissionBps: 1500, feeBps: 100, holdSecs: 15, state: "active", feeOwner: "F", feeEnforced: true,
  budget: { total: "5000000", spent: "0", remaining: "5000000" }, status: "active", sales: { settled: 3, refunded: 0, open: 0, refundRate: 0 }, volume: "0",
  listing: { name: o.address, description: "d", category: "data-feeds", endpointUrl: "https://x", route: "GET /r", displayPrice: price, isSample: false, updatedAt: null, ...over },
  links: { account: "" }, ...o });
const NOF: Filters = { q: "", category: null, budgetLeft: false, runway1000: false, noRefunds: false };

describe("singlePrice: one readable listed price, never a guess", () => {
  it("reads the common forms exactly", () => {
    expect(singlePrice("$0.10")).toBe(100000n); expect(singlePrice("0.10 USDC")).toBe(100000n); expect(singlePrice("$0.10 / call")).toBe(100000n);
    expect(singlePrice("$1")).toBe(1000000n); expect(singlePrice("$0.000001")).toBe(1n); expect(singlePrice("$25.5")).toBe(25500000n);
  });
  it("returns null for ranges, free text, zero and too many decimals", () => {
    for (const s of ["$0.03-$0.10", "$0.03 – $0.10", "from $0.05", "free", "", "$0", "$0.0000001", "$0.10 or $0.20"]) expect(singlePrice(s), s).toBeNull();
    expect(singlePrice(null)).toBeNull(); expect(singlePrice(undefined)).toBeNull();
  });
});

describe("splitOf matches the program and the site's own projection", () => {
  it("84000 / 15000 / 1000 for 0.10 USDC at 15% + 1%", () => { expect(splitOf(100000n, 1500, 100, 10n ** 12n)).toEqual({ merchant: 84000n, commission: 15000n, fee: 1000n }); });
  it("agrees with projectedSplit when the budget is not binding, over many prices and rates", () => {
    for (const u of [1n, 7n, 99n, 9999n, 100000n, 333333n, 1234567n]) for (const bps of [0, 1, 1500, 5000]) for (const fee of [0, 100, 500]) {
      const a = splitOf(u, bps, fee, 10n ** 15n), b = projectedSplit(u, bps, fee);
      expect([a.merchant.toString(), a.commission.toString(), a.fee.toString()]).toEqual([b.merchant, b.distributor, b.protocolFee]);
      expect(a.merchant + a.commission + a.fee).toBe(u);
    }
  });
  it("the budget caps the commission and the merchant keeps the rest (0.01 left, 0.015 owed)", () => {
    expect(splitOf(100000n, 1500, 100, 10000n)).toEqual({ merchant: 89000n, commission: 10000n, fee: 1000n });
    expect(splitOf(100000n, 1500, 100, 0n)).toEqual({ merchant: 99000n, commission: 0n, fee: 1000n });
  });
});

describe("earning and runway", () => {
  it("earn per sale is the floored commission at the listed price; null for a range", () => {
    expect(earnPerSale(mk({ address: "a" }))).toBe(15000n);
    expect(earnPerSale(mk({ address: "a" }, "$0.03-$0.10"))).toBeNull();
    expect(earnPerSale(mk({ address: "a", commissionBps: 1 }, "$0.000001"))).toBe(0n);
  });
  it("runway = remaining budget / earning per sale, floored (the design's 49.79 / 0.015 = 3319)", () => {
    expect(runwaySales(mk({ address: "a", budget: { total: "50000000", spent: "210000", remaining: "49790000" } }))).toBe(3319);
    expect(runwaySales(mk({ address: "a", budget: { total: "1", spent: "1", remaining: "0" } }))).toBe(0);
    expect(runwaySales(mk({ address: "a" }, "$0.03-$0.10"))).toBeNull(); // unknown, not zero
    expect(runwaySales(mk({ address: "a", commissionBps: 1 }, "$0.000001"))).toBeNull(); // earns 0 per sale: no meaningful runway
  });
  it("open means active state AND budget left", () => {
    expect(isOpen(mk({ address: "a" }))).toBe(true);
    expect(isOpen(mk({ address: "a", state: "paused" }))).toBe(false);
    expect(isOpen(mk({ address: "a", state: "ended" }))).toBe(false);
    expect(isOpen(mk({ address: "a", status: "budget_exhausted" }))).toBe(false);
    expect(isOpen({ status: "active" } as Campaign)).toBe(true); // an older API sends no state: active
  });
  it("totals count open campaigns and sum only their remaining budget", () => {
    const items = [mk({ address: "a" }), mk({ address: "b", state: "paused" }), mk({ address: "c", status: "budget_exhausted", budget: { total: "5", spent: "5", remaining: "0" } }), mk({ address: "d", budget: { total: "9000000", spent: "0", remaining: "9000000" } })];
    expect(directoryTotals(items)).toEqual({ listed: 4, open: 2, budgetAvailable: 14000000n });
  });
});

describe("refund text never shows a rate next to zero sales", () => {
  it("covers each case", () => {
    expect(refundText(mk({ address: "a", sales: { settled: 0, refunded: 0, open: 0, refundRate: null } }))).toBe("—");
    expect(refundText(mk({ address: "a", sales: { settled: 0, refunded: 1, open: 0, refundRate: 1 } }))).toBe("1 refunded");
    expect(refundText(mk({ address: "a", sales: { settled: 13, refunded: 0, open: 0, refundRate: 0 } }))).toBe("0%");
    expect(refundText(mk({ address: "a", sales: { settled: 7, refunded: 1, open: 0, refundRate: 0.125 } }))).toBe("12.5%");
  });
});

describe("sorting and filtering", () => {
  const a = mk({ address: "a", commissionBps: 1000, volume: "5" }, "$0.10"), b = mk({ address: "b", commissionBps: 3000, volume: "50" }, "$0.25"), c = mk({ address: "c", commissionBps: 2000, volume: "1" }, "$0.03-$0.10");
  it("most per sale puts unknown-price campaigns last", () => { expect(sortItems([a, c, b], "per-sale").map((x) => x.address)).toEqual(["b", "a", "c"]); }); // 0.075 > 0.01; c unknown
  it("highest commission and most volume", () => {
    expect(sortItems([a, b, c], "commission").map((x) => x.address)).toEqual(["b", "c", "a"]);
    expect(sortItems([a, b, c], "volume").map((x) => x.address)).toEqual(["b", "a", "c"]);
  });
  it("newest keeps the API's order and sorting never mutates its input", () => { const src = [c, a, b]; expect(sortItems(src, "newest").map((x) => x.address)).toEqual(["c", "a", "b"]); sortItems(src, "commission"); expect(src.map((x) => x.address)).toEqual(["c", "a", "b"]); });
  it("longest runway orders by sales left; unknown last; ties keep list order", () => {
    const big = mk({ address: "big", budget: { total: "99000000", spent: "0", remaining: "99000000" } }), small = mk({ address: "small" });
    expect(sortItems([small, c, big], "runway").map((x) => x.address)).toEqual(["big", "small", "c"]);
  });
  it("quick filters", () => {
    const refunded = mk({ address: "r", sales: { settled: 1, refunded: 1, open: 0, refundRate: 0.5 } }), spent = mk({ address: "s", status: "budget_exhausted", budget: { total: "5", spent: "5", remaining: "0" } });
    expect(matches(refunded, { ...NOF, noRefunds: true })).toBe(false); expect(matches(a, { ...NOF, noRefunds: true })).toBe(true);
    expect(matches(spent, { ...NOF, budgetLeft: true })).toBe(false); expect(matches(a, { ...NOF, budgetLeft: true })).toBe(true);
    expect(matches(a, { ...NOF, runway1000: true })).toBe(false); // 5.00 / 0.015 = 333 sales
    expect(matches(mk({ address: "x", budget: { total: "50000000", spent: "0", remaining: "50000000" } }), { ...NOF, runway1000: true })).toBe(true);
    expect(matches(c, { ...NOF, runway1000: true })).toBe(false); // unknown runway never passes a runway filter
  });
  it("search looks in name, description, route, endpoint, category and merchant; category filter and counts", () => {
    const m = mk({ address: "m", merchant: "7xKXq9Fp" }, "$0.10", { name: "Market brief", route: "GET /sample/brief", category: "research-search" });
    for (const q of ["market", "brief", "sample/brief", "7xkx", "research"]) expect(matches(m, { ...NOF, q }), q).toBe(true);
    expect(matches(m, { ...NOF, q: "nomatch" })).toBe(false);
    expect(matches(m, { ...NOF, category: "data-feeds" })).toBe(false); expect(matches(m, { ...NOF, category: "research-search" })).toBe(true);
    expect(categoryCounts([a, b, m])).toEqual({ "data-feeds": 2, "research-search": 1 });
  });
});
