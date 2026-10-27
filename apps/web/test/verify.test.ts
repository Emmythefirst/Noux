import { describe, it, expect } from "vitest";
import { b58decode, b58encode, checkSplit, claimMessage, decodeCampaign, decodeSale, parseEd25519, verifyReceipt, type SaleAccount } from "../src/lib/verify";

const pk = (n: number) => { const b = new Uint8Array(32); b.fill(n); return b58encode(b); };

function saleBytes(o: Partial<{ status: number; gross: bigint; merchant: bigint; commission: bigint; fee: bigint; cbps: number; fbps: number }> = {}) {
  const d = new Uint8Array(8 + 32 * 5 + 8 * 4 + 8 * 5 + 2 + 2 + 1 + 1), v = new DataView(d.buffer);
  d.fill(1, 8, 40); d.fill(2, 40, 72); d.fill(3, 72, 104); d.fill(4, 104, 136); d.fill(5, 136, 168);
  v.setBigInt64(168, 1000n, true); v.setBigInt64(176, 900n, true); v.setBigInt64(184, 915n, true); v.setBigInt64(192, 920n, true);
  v.setBigUint64(200, 100000n, true); v.setBigUint64(208, o.gross ?? 100000n, true); v.setBigUint64(216, o.merchant ?? 84000n, true);
  v.setBigUint64(224, o.commission ?? 15000n, true); v.setBigUint64(232, o.fee ?? 1000n, true);
  v.setUint16(240, o.cbps ?? 1500, true); v.setUint16(242, o.fbps ?? 100, true); d[244] = o.status ?? 1; d[245] = 254;
  return d;
}

describe("base58", () => {
  it("round-trips, including leading zero bytes", () => {
    for (const hex of ["00", "0000ff", "ff00ff", "0102030405060708090a"]) {
      const b = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
      expect(Array.from(b58decode(b58encode(b)))).toEqual(Array.from(b));
    }
    expect(b58encode(new Uint8Array(32))).toBe("11111111111111111111111111111111");
  });
  it("rejects characters outside the alphabet", () => { expect(() => b58decode("0OIl")).toThrow(); });
});

describe("account decoding (layout from program/programs/noux/src/lib.rs)", () => {
  it("decodes a settled sale", () => {
    const s = decodeSale(saleBytes());
    expect(s).toMatchObject({ campaign: pk(1), distributor: pk(2), buyer: pk(3), price: 100000n, gross: 100000n, merchantAmount: 84000n, commissionAmount: 15000n, feeAmount: 1000n, commissionBps: 1500, feeBps: 100, status: "settled", expiry: 1000n });
    expect(s.nonce.every((x) => x === 5)).toBe(true);
    expect(decodeSale(saleBytes({ status: 0 })).status).toBe("open");
    expect(decodeSale(saleBytes({ status: 2 })).status).toBe("refunded");
  });
  it("refuses a bad status or a truncated account", () => {
    expect(() => decodeSale(saleBytes({ status: 9 }))).toThrow();
    expect(() => decodeSale(saleBytes().slice(0, 100))).toThrow();
  });
  it("decodes a campaign (built field by field in the Rust struct order, not from the decoder's own offsets)", () => {
    // Campaign: merchant, mint, fee_owner, attribution_key (4 x 32), cluster[8], hold_secs u32, settled u64, refunded u64, id u64, budget u64, spent u64, commission_bps u16, fee_bps u16, bump u8
    const parts: Uint8Array[] = [new Uint8Array(8)]; // anchor discriminator
    for (const n of [6, 7, 8, 9]) parts.push(new Uint8Array(32).fill(n));
    parts.push(Uint8Array.from([...new TextEncoder().encode("devnet"), 0, 0]));
    const u = (n: bigint, size: number) => { const b = new Uint8Array(size); new DataView(b.buffer)[size === 4 ? "setUint32" : size === 2 ? "setUint16" : "setBigUint64"](0, (size === 8 ? n : Number(n)) as never, true); return b; };
    parts.push(u(15n, 4), u(1n, 8), u(2n, 8), u(3n, 8), u(5000000n, 8), u(30000n, 8), u(1500n, 2), u(100n, 2), Uint8Array.of(255));
    const d = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { d.set(p, o); o += p.length; }
    expect(d.length).toBe(193);
    const c = decodeCampaign(d);
    expect(c).toMatchObject({ mint: pk(7), attributionKey: pk(9), commissionBps: 1500, feeBps: 100 });
    expect(new TextDecoder().decode(c.cluster.slice(0, 6))).toBe("devnet");
  });
});

describe("claim message", () => {
  const s = decodeSale(saleBytes());
  const cluster = new Uint8Array(8); cluster.set(new TextEncoder().encode("devnet"));
  it("is 197 bytes with the domain tag first", () => {
    const m = claimMessage(pk(8), cluster, s);
    expect(m.length).toBe(197);
    expect(new TextDecoder().decode(m.slice(0, 13))).toBe("NOUX-CLAIM-v1");
  });
  it("changes when any bound field changes", () => {
    const base = claimMessage(pk(8), cluster, s);
    const diff = (x: Uint8Array) => x.some((b, i) => b !== base[i]);
    expect(diff(claimMessage(pk(8), cluster, { ...s, price: 100001n }))).toBe(true);
    expect(diff(claimMessage(pk(8), cluster, { ...s, buyer: pk(6) }))).toBe(true);
    expect(diff(claimMessage(pk(8), cluster, { ...s, distributor: pk(6) }))).toBe(true);
    expect(diff(claimMessage(pk(8), cluster, { ...s, expiry: 1001n }))).toBe(true);
    expect(diff(claimMessage(pk(8), cluster, { ...s, nonce: new Uint8Array(32) }))).toBe(true);
    expect(diff(claimMessage(pk(10), cluster, s))).toBe(true);
  });
});

describe("ed25519 instruction parsing", () => {
  it("extracts pubkey and message by offsets", () => {
    const msg = new Uint8Array([9, 8, 7]), key = new Uint8Array(32).fill(4), sig = new Uint8Array(64).fill(1);
    const d = new Uint8Array(16 + 32 + 64 + 3), v = new DataView(d.buffer);
    d[0] = 1; v.setUint16(2, 48, true); v.setUint16(6, 16, true); v.setUint16(10, 112, true); v.setUint16(12, 3, true);
    d.set(key, 16); d.set(sig, 48); d.set(msg, 112);
    const p = parseEd25519(d)!;
    expect(Array.from(p.pubkey)).toEqual(Array.from(key)); expect(Array.from(p.message)).toEqual([9, 8, 7]);
    expect(parseEd25519(new Uint8Array(4))).toBeNull();
    d[0] = 2; expect(parseEd25519(d)).toBeNull();
  });
});

describe("split check", () => {
  const ok = { gross: 100000n, merchantAmount: 84000n, commissionAmount: 15000n, feeAmount: 1000n, commissionBps: 1500, feeBps: 100 };
  it("accepts the program's rounding and the budget-cap case", () => {
    expect(checkSplit(ok)).toMatchObject({ ok: true, capApplied: false });
    expect(checkSplit({ gross: 33333n, merchantAmount: 28001n, commissionAmount: 4999n, feeAmount: 333n, commissionBps: 1500, feeBps: 100 }).ok).toBe(true); // floors
    expect(checkSplit({ ...ok, merchantAmount: 94000n, commissionAmount: 5000n })).toMatchObject({ ok: true, capApplied: true });
  });
  it("rejects every way of cheating the split", () => {
    expect(checkSplit({ ...ok, feeAmount: 1001n, merchantAmount: 83999n }).ok).toBe(false);     // wrong fee
    expect(checkSplit({ ...ok, commissionAmount: 15001n, merchantAmount: 83999n }).ok).toBe(false); // commission above the terms
    expect(checkSplit({ ...ok, merchantAmount: 83999n }).ok).toBe(false);                        // remainder wrong
  });
});

// Live: re-verifies a real devnet receipt against a real RPC node. Opt in with LIVE=1 (needs network).
describe.skipIf(!process.env.LIVE)("live devnet receipt", () => {
  const sale = "AjpAUxR7X5HPGaKdRaFZ9CwSumPZ5pt1gxkp6EjfcKFx";
  const open = "https://explorer.solana.com/tx/5SdmXEUQjfGpiNcS3N652MnM8jGAprTMMss42mHRmMMYzY3pnJxrAdbEpGJCKLYCKYcFfgEF9HXasKk4UGvwfnmA?cluster=devnet";
  const pay = "https://explorer.solana.com/tx/2vepYCGCyAZmTVC1JSBzixkb5AKqY5JzotFKLAHs1sf8fTJPFx9AGAuShZBQmdrsqHxtySomVfMg5w4Wcr4eCqCb?cluster=devnet";
  const split = { merchant: "84000", distributor: "15000", protocolFee: "1000" };
  it("passes all four checks", async () => {
    const r = await verifyReceipt({ sale, openTx: open, paymentTx: pay, apiGross: "100000", apiSplit: split });
    console.log(r);
    expect(r.map((x) => x.state)).toEqual(["pass", "pass", "pass", "pass"]);
  }, 60000);
  it("fails when the page lies about the split", async () => {
    const r = await verifyReceipt({ sale, openTx: open, paymentTx: pay, apiGross: "100000", apiSplit: { merchant: "90000", distributor: "9000", protocolFee: "1000" } });
    expect(r[2].state).toBe("fail");
  }, 60000);
  it("fails the claim check when pointed at a different sale's open transaction", async () => {
    const other = "2bh2qN6mS4AZohyUatuisRUSknXGMPb7smDLBwPE3JZX";
    const r = await verifyReceipt({ sale: other, openTx: open, paymentTx: pay, apiGross: "100000", apiSplit: split });
    expect(r[0].state).toBe("fail"); expect(r[1].state).toBe("fail");
  }, 60000);
  it("a refunded sale: claim and payer still verify, split and sum are not applicable", async () => {
    const r = await verifyReceipt({
      sale: "5XWpC549g5J8tuiyCkatNdVUtVzYVhXjRrZBeZ1pg3XE",
      openTx: "https://explorer.solana.com/tx/2GVrfsX49ovVFuBYfSGDAJbssHsxg9Ch1hcZ7WgnyBidNjU2FTv4i1FrPJ97xuHNkaCD6jtinSVMcAFrPCz1MGiV?cluster=devnet",
      paymentTx: "https://explorer.solana.com/tx/5Zt5ZQiqwakiZXN51hKkk2ngdmTj2cWTA69wG1HQQzgZ9pigeq5WJbseoLktxk73XMg1hA8y9Ni49eDhseM6RriG?cluster=devnet",
      apiGross: "100000", apiSplit: { merchant: "0", distributor: "0", protocolFee: "0" } });
    expect(r.map((x) => x.state)).toEqual(["pass", "pass", "skip", "skip"]);
  }, 60000);
});
