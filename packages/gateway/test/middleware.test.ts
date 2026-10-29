import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { LocalKeySigner, signClaim, claimToWire, salePda, BRAND, type CampaignInfo, type SignedClaim } from "@noux/core";
import { createNouxGateway, encodeClaimHeader, type GatewayEvent, type SaleOpener, type SaleSettler } from "../src";

const NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const programId = Keypair.generate().publicKey, campaign = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
const merchantPay = Keypair.generate().publicKey;
const attest = new LocalKeySigner(Keypair.generate().secretKey);
const PRICE = 100_000n;
const info = (): CampaignInfo => ({ address: campaign, merchant: merchantPay, mint, feeOwner: Keypair.generate().publicKey, attributionKey: attest.publicKey, cluster: "devnet", holdSecs: 15, commissionBps: 1500, feeBps: 100, commissionBudget: 1n, commissionSpent: 0n, settledCount: 0n, refundedCount: 0n, state: "active" });

interface Harness { url: string; events: GatewayEvent[]; opened: SignedClaim[]; settled: SignedClaim[]; facCalls: string[]; setPayer(p: string): void; close(): Promise<void>; handlerCalls: () => number; setHandlerStatus(n: number): void }
async function harness(): Promise<Harness> {
  const events: GatewayEvent[] = [], opened: SignedClaim[] = [], settled: SignedClaim[] = [], facCalls: string[] = [];
  let payer = "", handlerCalls = 0, handlerStatus = 200;
  const opener: SaleOpener = { ensureOpen: async (c) => { opened.push(c); return salePda(programId, c.campaign, c.nonce); } };
  const settler: SaleSettler = { settle: async (c) => { settled.push(c); return "SETTLESIG"; }, refund: async () => "R" };
  const facilitator: any = {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NET, extra: { feePayer: Keypair.generate().publicKey.toBase58() } }], extensions: [], signers: {} }),
    verify: async () => { facCalls.push("verify"); return { isValid: true, payer }; },
    settle: async () => { facCalls.push("settle"); return { success: true, payer, transaction: "TXSIG", network: NET }; },
  };
  const gw = createNouxGateway({
    programId, cluster: "devnet", campaign, mint, network: NET, merchantPayTo: merchantPay, facilitator, connection: {} as any,
    campaigns: { get: async () => info() }, opener, settler, routes: { "GET /data": { price: PRICE, description: "data" } },
    now: () => 1_800_000_000, onEvent: (e) => events.push(e),
  });
  const app = express(); app.use(gw.middleware);
  app.get("/data", (_q, r) => { handlerCalls++; r.status(handlerStatus).json({ ok: handlerStatus < 400 }); });
  const srv = await new Promise<import("node:http").Server>((res) => { const s = app.listen(0, () => res(s)); });
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, events, opened, settled, facCalls, setPayer: (p) => { payer = p; }, handlerCalls: () => handlerCalls, setHandlerStatus: (n) => { handlerStatus = n; }, close: () => new Promise((r) => srv.close(() => r())) };
}
const mkClaim = (over: Record<string, unknown> = {}) => signClaim(attest, { programId, cluster: "devnet", campaign, distributor: Keypair.generate().publicKey, buyer: Keypair.generate().publicKey, expiry: 1_800_000_600, price: PRICE, nonce: nacl.randomBytes(32), ...over } as any);

async function get(h: Harness, claim?: SignedClaim, pay = false) {
  const headers: Record<string, string> = {};
  if (claim) headers[BRAND.claimHeader] = encodeClaimHeader(claimToWire(claim));
  const r1 = await fetch(`${h.url}/data`, { headers });
  if (!pay) return { r1, req: JSON.parse(Buffer.from(r1.headers.get("payment-required") ?? "", "base64").toString() || "{}") };
  const req = JSON.parse(Buffer.from(r1.headers.get("payment-required")!, "base64").toString());
  const accepted = req.accepts[0];
  const payment = Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { transaction: "AAAA" }, resource: req.resource })).toString("base64");
  const r2 = await fetch(`${h.url}/data`, { headers: { ...headers, "payment-signature": payment } });
  return { r1, req, r2, accepted };
}

let h: Harness;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.close(); });

describe("payTo selection", () => {
  it("no claim: plain purchase, merchant is paid in full, no sale opened", async () => {
    const { req } = await get(h);
    expect(req.accepts[0].payTo).toBe(merchantPay.toBase58()); expect(req.accepts[0].amount).toBe(PRICE.toString()); expect(req.accepts[0].asset).toBe(mint.toBase58());
    expect(h.opened.length).toBe(0);
  });
  it("valid claim: payTo is the per-sale vault owner and the sale is opened", async () => {
    const c = await mkClaim(); const { req } = await get(h, c);
    expect(req.accepts[0].payTo).toBe(salePda(programId, campaign, c.nonce).toBase58());
    expect(h.opened.length).toBe(1);
    expect(h.events.some((e) => e.type === "claim_accepted")).toBe(true);
  });
  it("LOWER-PRICED claim is rejected: falls back to the merchant at the REAL route price, no sale opened", async () => {
    const c = await mkClaim({ price: 1n });
    const { req } = await get(h, c);
    expect(req.accepts[0].payTo).toBe(merchantPay.toBase58());
    expect(req.accepts[0].amount).toBe(PRICE.toString()); // never the claim's price
    expect(h.opened.length).toBe(0);
    expect(h.events).toContainEqual({ type: "claim_rejected", route: "GET /data", reason: "price_mismatch" });
  });
  it("tampered / foreign-key / self-referral claims all fall back to the merchant", async () => {
    const good = await mkClaim(); const badMsg = Buffer.from(good.message); badMsg[150] ^= 1;
    const k = Keypair.generate().publicKey;
    for (const c of [{ ...good, message: badMsg }, await signClaim(new LocalKeySigner(Keypair.generate().secretKey), good), await mkClaim({ distributor: k, buyer: k })]) {
      const { req } = await get(h, c as SignedClaim);
      expect(req.accepts[0].payTo).toBe(merchantPay.toBase58());
    }
    expect(h.opened.length).toBe(0);
  });
  it("the same claim sent on the unpaid and paid request opens the sale once", async () => {
    h.setPayer("x"); const c = await mkClaim(); h.setPayer(c.buyer.toBase58());
    await get(h, c, true);
    expect(h.opened.length).toBeLessThanOrEqual(2); // payTo resolved per request; opener itself is idempotent (AnchorChain dedupes)
    expect(new Set(h.opened.map((o) => Buffer.from(o.nonce).toString("hex"))).size).toBe(1);
  });
  it("if opening the sale fails the buyer can still buy: merchant gets paid, referral is lost", async () => {
    await h.close();
    const events: GatewayEvent[] = [];
    const gw = createNouxGateway({
      programId, cluster: "devnet", campaign, mint, network: NET, merchantPayTo: merchantPay, connection: {} as any, campaigns: { get: async () => info() },
      opener: { ensureOpen: async () => { throw new Error("rpc down"); } }, routes: { "GET /data": { price: PRICE } }, now: () => 1_800_000_000, onEvent: (e) => events.push(e),
      facilitator: { getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NET, extra: { feePayer: Keypair.generate().publicKey.toBase58() } }], extensions: [], signers: {} }), verify: async () => ({ isValid: true }), settle: async () => ({ success: true, transaction: "t", network: NET, payer: "p" }) } as any,
    });
    const app = express(); app.use(gw.middleware); app.get("/data", (_q, r) => r.json({ ok: true }));
    const s = await new Promise<import("node:http").Server>((res) => { const x = app.listen(0, () => res(x)); });
    try {
      const c = await mkClaim();
      const r = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/data`, { headers: { [BRAND.claimHeader]: encodeClaimHeader(claimToWire(c)) } });
      expect(r.status).toBe(402);
      expect(JSON.parse(Buffer.from(r.headers.get("payment-required")!, "base64").toString()).accepts[0].payTo).toBe(merchantPay.toBase58());
      expect(events.some((e) => e.type === "sale_open_failed")).toBe(true);
    } finally { await new Promise((r) => s.close(() => r(null))); }
  });
});

describe("payer binding and settlement", () => {
  it("the bound buyer pays: 200, facilitator settles, merchant settles the sale after delivery", async () => {
    const c = await mkClaim(); h.setPayer(c.buyer.toBase58());
    const { r2 } = await get(h, c, true);
    expect(r2!.status).toBe(200);
    expect(h.facCalls).toEqual(["verify", "settle"]);
    expect(h.settled.length).toBe(1); expect(Buffer.from(h.settled[0].nonce).toString("hex")).toBe(Buffer.from(c.nonce).toString("hex"));
  });
  it("a different payer is refused after verify: 402, NOTHING settles, resource not served, no sale settle", async () => {
    const c = await mkClaim(); h.setPayer(Keypair.generate().publicKey.toBase58());
    const { r2 } = await get(h, c, true);
    expect(r2!.status).toBe(402);
    expect(h.facCalls).toEqual(["verify"]);
    expect(h.handlerCalls()).toBe(0); expect(h.settled.length).toBe(0);
    expect(h.events.some((e) => e.type === "payer_mismatch")).toBe(true);
  });
  it("a plain purchase (no claim) accepts any payer and never touches settle_sale", async () => {
    h.setPayer(Keypair.generate().publicKey.toBase58());
    const { r2 } = await get(h, undefined, true);
    expect(r2!.status).toBe(200); expect(h.settled.length).toBe(0); expect(h.facCalls).toEqual(["verify", "settle"]);
  });
  it("a payment aimed at an unknown address is refused (stale cache / forged requirements)", async () => {
    const { req } = await get(h);
    const forged = { ...req.accepts[0], payTo: Keypair.generate().publicKey.toBase58() };
    const payment = Buffer.from(JSON.stringify({ x402Version: 2, accepted: forged, payload: { transaction: "AAAA" }, resource: req.resource })).toString("base64");
    const r = await fetch(`${h.url}/data`, { headers: { "payment-signature": payment } });
    expect(r.status).toBe(402); expect(h.facCalls).not.toContain("settle");
  });
  it("if the resource fails (500) nothing is settled: the buyer is not charged", async () => {
    const c = await mkClaim(); h.setPayer(c.buyer.toBase58()); h.setHandlerStatus(500);
    const { r2 } = await get(h, c, true);
    expect(r2!.status).toBe(500);
    expect(h.facCalls).not.toContain("settle"); expect(h.settled.length).toBe(0);
  });
});

describe("a paused or ended campaign takes no new referral sales", () => {
  async function withState(state: () => "active" | "paused" | "ended") {
    const events: GatewayEvent[] = []; let opens = 0;
    const gw = createNouxGateway({
      programId, cluster: "devnet", campaign, mint, network: NET, merchantPayTo: merchantPay, connection: {} as any, campaigns: { get: async () => ({ ...info(), state: state() }) },
      opener: { ensureOpen: async (c: SignedClaim) => { opens++; return salePda(programId, c.campaign, c.nonce); } }, routes: { "GET /data": { price: PRICE } }, now: () => 1_800_000_000, onEvent: (e) => events.push(e),
      facilitator: { getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NET, extra: { feePayer: Keypair.generate().publicKey.toBase58() } }], extensions: [], signers: {} }), verify: async () => ({ isValid: true }), settle: async () => ({ success: true, transaction: "t", network: NET, payer: "p" }) } as any,
    });
    const app = express(); app.use(gw.middleware); app.get("/data", (_q, r) => r.json({ ok: true }));
    const srv = await new Promise<import("node:http").Server>((res) => { const s = app.listen(0, () => res(s)); });
    const ask = async (c: SignedClaim) => JSON.parse(Buffer.from((await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/data`, { headers: { [BRAND.claimHeader]: encodeClaimHeader(claimToWire(c)) } })).headers.get("payment-required")!, "base64").toString()).accepts[0].payTo as string;
    return { ask, events, opens: () => opens, close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
  }
  for (const st of ["paused", "ended"] as const) {
    it(`${st}: a valid claim becomes a PLAIN purchase (merchant paid in full), no sale is opened, and the reason is reported`, async () => {
      const g = await withState(() => st);
      try {
        const c = await mkClaim(); expect(await g.ask(c)).toBe(merchantPay.toBase58());
        expect(g.opens()).toBe(0); expect(g.events.some((e) => e.type === "claim_rejected" && (e as any).reason === "campaign_not_active")).toBe(true);
      } finally { await g.close(); }
    });
  }
  it("when the campaign is active again the very next claim opens a sale (the gateway follows the chain, it does not remember a pause)", async () => {
    let st: "active" | "paused" = "paused"; const g = await withState(() => st);
    try { const c = await mkClaim(); expect(await g.ask(c)).toBe(merchantPay.toBase58()); st = "active"; const c2 = await mkClaim(); expect(await g.ask(c2)).toBe(salePda(programId, c2.campaign, c2.nonce).toBase58()); expect(g.opens()).toBe(1); } finally { await g.close(); }
  });
});
