import { describe, it, expect } from "vitest";
import { checkRequirement, priceNumbers, type Requirement } from "../src/lib/buy-checks";

const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", OTHER = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const req = (o: Partial<Requirement> = {}): Requirement => ({ scheme: "exact", network: DEVNET, amount: "100000", asset: MINT, payTo: "PAYEE", ...o });
const ctx = (displayPrice: string | null = "$0.10") => ({ campaignMint: MINT, decimals: 6, chain: "solana:devnet", displayPrice });

describe("buy page: the 402 must match the campaign and its listing before the wallet is asked", () => {
  it("a matching answer passes (the live sample merchant: $0.10, devnet USDC)", () => { expect(checkRequirement(req(), ctx())).toBeNull(); });
  it("a price range in the listing accepts anything inside it (the sample listing says $0.03-$0.10)", () => {
    for (const amount of ["30000", "100000", "50000"]) expect(checkRequirement(req({ amount }), ctx("$0.03-$0.10"))).toBeNull();
  });
  it("an endpoint asking for MORE than the listing says is refused, with both numbers in the message", () => {
    const m = checkRequirement(req({ amount: "5000000" }), ctx("$0.10"));
    expect(m).toMatch(/asks for 5 but its listing says \$0\.10/); expect(m).toMatch(/Nothing was sent/);
  });
  it("asking for less than a single listed price is also a mismatch (a stale or lying listing)", () => { expect(checkRequirement(req({ amount: "1000" }), ctx("$0.10"))).toMatch(/listing says/); });
  it("a range's edges are inclusive, and one base unit outside is not", () => {
    expect(checkRequirement(req({ amount: "30000" }), ctx("$0.03-$0.10"))).toBeNull(); expect(checkRequirement(req({ amount: "100000" }), ctx("$0.03-$0.10"))).toBeNull();
    expect(checkRequirement(req({ amount: "100002" }), ctx("$0.03-$0.10"))).not.toBeNull(); expect(checkRequirement(req({ amount: "29998" }), ctx("$0.03-$0.10"))).not.toBeNull();
  });
  it("a different token than the campaign's is refused even when the amount looks right", () => {
    expect(checkRequirement(req({ asset: OTHER }), ctx())).toMatch(/different token/);
  });
  it("a different network is refused (devnet site, mainnet request)", () => {
    expect(checkRequirement(req({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }), ctx())).toMatch(/different network/);
  });
  it("an unsupported scheme, or a malformed amount, is refused", () => {
    expect(checkRequirement(req({ scheme: "upto" }), ctx())).toMatch(/scheme/); expect(checkRequirement(req({ amount: "-5" }), ctx())).toMatch(/valid price/); expect(checkRequirement(req({ amount: "1e9" }), ctx())).toMatch(/valid price/);
  });
  it("a listing with no readable price cannot be compared, so it does not block (token and network are still checked)", () => {
    expect(checkRequirement(req({ amount: "123456" }), ctx("free"))).toBeNull(); expect(checkRequirement(req({ asset: OTHER }), ctx("free"))).toMatch(/different token/);
  });
  it("priceNumbers reads the display formats merchants use", () => {
    expect(priceNumbers("$0.10")).toEqual([0.1]); expect(priceNumbers("$0.03-$0.10")).toEqual([0.03, 0.1]); expect(priceNumbers("0.5 USDC")).toEqual([0.5]); expect(priceNumbers("free")).toEqual([]); expect(priceNumbers(null)).toEqual([]);
  });
});
