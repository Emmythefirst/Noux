import { describe, it, expect } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { LocalKeySigner, signClaim, claimToWire, salePda, BRAND, type CampaignInfo, type SignedClaim } from "@noux/core";
import { createNouxGateway, encodeClaimHeader, type GatewayEvent, type SaleOpener, type SaleSettler } from "../src";

// Concurrency behaviour of the real middleware (real express + @x402/express) with a fake chain and facilitator.
const NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const programId = Keypair.generate().publicKey, campaign = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
const merchantPay = Keypair.generate().publicKey;
const attest = new LocalKeySigner(Keypair.generate().secretKey);
const PRICE = 100_000n;
const info = (): CampaignInfo => ({ address: campaign, merchant: merchantPay, mint, feeOwner: Keypair.generate().publicKey, attributionKey: attest.publicKey, cluster: "devnet", holdSecs: 15, commissionBps: 1500, feeBps: 100, commissionBudget: 1n, commissionSpent: 0n, settledCount: 0n, refundedCount: 0n, state: "active" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 8000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await sleep(20); };
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const mkClaim = (buyer = Keypair.generate().publicKey) => signClaim(attest, { programId, cluster: "devnet", campaign, distributor: Keypair.generate().publicKey, buyer, expiry: 1_800_000_600, price: PRICE, nonce: nacl.randomBytes(32) } as any);

interface Opts { openMs?: number; settleMs?: number; settle?: SaleSettler["settle"]; settleWaitMs?: number }
async function start(o: Opts = {}) {
  const events: GatewayEvent[] = [], opened: string[] = [], settled: string[] = [];
  let handlerCalls = 0, verifyCalls = 0, settleCalls = 0, inFlightOpen = 0, maxInFlightOpen = 0;
  const opener: SaleOpener = { ensureOpen: async (c) => { inFlightOpen++; maxInFlightOpen = Math.max(maxInFlightOpen, inFlightOpen); await sleep(o.openMs ?? 0); inFlightOpen--; opened.push(hex(c.nonce)); return salePda(programId, c.campaign, c.nonce); } };
  const settler: SaleSettler = { settle: o.settle ?? (async (c) => { await sleep(o.settleMs ?? 0); settled.push(hex(c.nonce)); return "SIG"; }), refund: async () => "R" };
  // the payer travels inside the payment payload, so every concurrent request has its own payer
  const facilitator: any = {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NET, extra: { feePayer: Keypair.generate().publicKey.toBase58() } }], extensions: [], signers: {} }),
    verify: async (p: any) => { verifyCalls++; return { isValid: true, payer: p.payload.transaction }; },
    settle: async (p: any) => { settleCalls++; return { success: true, payer: p.payload.transaction, transaction: "TX", network: NET }; },
  };
  const gw = createNouxGateway({
    programId, cluster: "devnet", campaign, mint, network: NET, merchantPayTo: merchantPay, facilitator, connection: {} as any,
    campaigns: { get: async () => info() }, opener, settler, routes: { "GET /data": { price: PRICE } }, now: () => 1_800_000_000, onEvent: (e: GatewayEvent) => events.push(e),
    ...(o.settleWaitMs !== undefined ? { settleAfterDeliveryWaitMs: o.settleWaitMs } : {}),
  } as any);
  const app = express(); app.use(gw.middleware);
  app.get("/data", (_q, r) => { handlerCalls++; r.json({ ok: true }); });
  const srv = await new Promise<import("node:http").Server>((res) => { const s = app.listen(0, () => res(s)); });
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/data`;
  return {
    url, events, opened, settled, gw, close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
    counts: () => ({ handlerCalls, verifyCalls, settleCalls, maxInFlightOpen }),
  };
}
type G = Awaited<ReturnType<typeof start>>;

/** unpaid request, then the paid retry with `payer` as the paying wallet */
async function buy(g: G, claim: SignedClaim, payer: string) {
  const headers = { [BRAND.claimHeader]: encodeClaimHeader(claimToWire(claim)) };
  const r1 = await fetch(g.url, { headers });
  const req = JSON.parse(Buffer.from(r1.headers.get("payment-required")!, "base64").toString());
  const payment = Buffer.from(JSON.stringify({ x402Version: 2, accepted: req.accepts[0], payload: { transaction: payer }, resource: req.resource })).toString("base64");
  const r2 = await fetch(g.url, { headers: { ...headers, "payment-signature": payment } });
  return { r1, r2, payTo: req.accepts[0].payTo as string };
}

describe("gateway under concurrent load", () => {
  it("150 concurrent buyers with distinct claims: every one is served once, every sale settles once, no cross-talk", async () => {
    const g = await start({ openMs: 20, settleMs: 20 });
    try {
      const claims = await Promise.all(Array.from({ length: 150 }, () => mkClaim()));
      const out = await Promise.all(claims.map((c) => buy(g, c, c.buyer.toBase58())));
      expect(out.every((o) => o.r2.status === 200)).toBe(true);
      // each response was routed to ITS sale vault
      claims.forEach((c, i) => expect(out[i].payTo).toBe(salePda(programId, c.campaign, c.nonce).toBase58()));
      expect(g.counts().handlerCalls).toBe(150);
      await until(() => g.settled.length === 150); // settle-after-delivery runs detached
      expect(g.settled.length).toBe(150);
      expect(new Set(g.settled).size).toBe(150);
      expect(new Set(g.opened).size).toBe(150);
      expect(g.events.filter((e) => e.type === "payer_mismatch" || e.type === "unknown_payto").length).toBe(0);
    } finally { await g.close(); }
  }, 30_000);

  it("60 concurrent attackers paying with someone else's claim: all refused, nothing served, nothing settled", async () => {
    const g = await start();
    try {
      const claims = await Promise.all(Array.from({ length: 60 }, () => mkClaim()));
      const out = await Promise.all(claims.map((c) => buy(g, c, Keypair.generate().publicKey.toBase58())));
      expect(out.every((o) => o.r2.status === 402)).toBe(true);
      expect(g.counts().handlerCalls).toBe(0);
      expect(g.counts().settleCalls).toBe(0);
      expect(g.settled.length).toBe(0);
      expect(g.events.filter((e) => e.type === "payer_mismatch").length).toBe(60);
    } finally { await g.close(); }
  }, 30_000);

  it("a slow opener does not serialise requests: 200 concurrent unpaid calls finish in about one opener latency, not 200", async () => {
    const g = await start({ openMs: 200 });
    try {
      const claims = await Promise.all(Array.from({ length: 200 }, () => mkClaim()));
      const t = Date.now();
      const rs = await Promise.all(claims.map((c) => fetch(g.url, { headers: { [BRAND.claimHeader]: encodeClaimHeader(claimToWire(c)) } })));
      const ms = Date.now() - t;
      expect(rs.every((r) => r.status === 402)).toBe(true);
      expect(ms).toBeLessThan(10_000); // 40 s if serialised
      expect(g.counts().maxInFlightOpen).toBeGreaterThan(1); // openers overlap
    } finally { await g.close(); }
  }, 30_000);

  it("a mix of 100 plain purchases and 100 referred purchases at once: plain buyers never touch the chain", async () => {
    const g = await start({ openMs: 10, settleMs: 10 });
    try {
      const plain = Array.from({ length: 100 }, async () => {
        const r1 = await fetch(g.url); const req = JSON.parse(Buffer.from(r1.headers.get("payment-required")!, "base64").toString());
        const pay = Buffer.from(JSON.stringify({ x402Version: 2, accepted: req.accepts[0], payload: { transaction: Keypair.generate().publicKey.toBase58() }, resource: req.resource })).toString("base64");
        return (await fetch(g.url, { headers: { "payment-signature": pay } })).status;
      });
      const referred = Array.from({ length: 100 }, async () => { const c = await mkClaim(); return (await buy(g, c, c.buyer.toBase58())).r2.status; });
      const statuses = await Promise.all([...plain, ...referred]);
      expect(statuses.every((s) => s === 200)).toBe(true);
      await until(() => g.settled.length >= 100); await sleep(100);
      expect(g.settled.length).toBe(100); // only the referred ones
    } finally { await g.close(); }
  }, 30_000);
});

describe("settlement after delivery must not hold the buyer's response hostage", () => {
  it("a settler that takes 1.5 s: how long does the buyer wait?", async () => {
    const g = await start({ settleMs: 1500 });
    try {
      const c = await mkClaim(); const t0 = Date.now();
      const { r2 } = await buy(g, c, c.buyer.toBase58());
      const waited = Date.now() - t0;
      expect(r2.status).toBe(200);
      expect(waited).toBeLessThan(1000); // the response must not wait for the merchant's settle transaction
    } finally { await g.close(); }
  }, 30_000);

  it("a settler that never answers does not hang the buyer", async () => {
    const g = await start({ settle: () => new Promise<string | null>(() => {}) });
    try {
      const c = await mkClaim();
      const winner = await Promise.race([buy(g, c, c.buyer.toBase58()).then((o) => o.r2.status), sleep(4000).then(() => "HUNG" as const)]);
      expect(winner).toBe(200);
    } finally { await g.close(); }
  }, 30_000);
});

describe("the gateway's answer for one claim must not change between the unpaid and the paid request", () => {
  async function flaky(failFirst: number) {
    const events: GatewayEvent[] = []; let calls = 0;
    const opener: SaleOpener = { ensureOpen: async (c) => { calls++; if (calls <= failFirst) throw new Error("rpc overloaded"); return salePda(programId, c.campaign, c.nonce); } };
    const facilitator: any = {
      getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NET, extra: { feePayer: Keypair.generate().publicKey.toBase58() } }], extensions: [], signers: {} }),
      verify: async (p: any) => ({ isValid: true, payer: p.payload.transaction }), settle: async (p: any) => ({ success: true, payer: p.payload.transaction, transaction: "TX", network: NET }),
    };
    const gw = createNouxGateway({ programId, cluster: "devnet", campaign, mint, network: NET, merchantPayTo: merchantPay, facilitator, connection: {} as any, campaigns: { get: async () => info() }, opener, routes: { "GET /data": { price: PRICE } }, now: () => 1_800_000_000, onEvent: (e: GatewayEvent) => events.push(e) });
    const app = express(); app.use(gw.middleware); app.get("/data", (_q, r) => r.json({ ok: true }));
    const srv = await new Promise<import("node:http").Server>((res) => { const s = app.listen(0, () => res(s)); });
    return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/data`, events, calls: () => calls, close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
  }
  const payTo = async (url: string, claim: SignedClaim) => JSON.parse(Buffer.from((await fetch(url, { headers: { [BRAND.claimHeader]: encodeClaimHeader(claimToWire(claim)) } })).headers.get("payment-required")!, "base64").toString()).accepts[0].payTo as string;

  it("if opening the sale failed the first time, the retry with the same claim keeps answering 'merchant' (no flip), so the buyer's payment is accepted", async () => {
    const g = await flaky(1);
    try {
      const c = await mkClaim(); const first = await payTo(g.url, c);
      expect(first).toBe(merchantPay.toBase58()); // fail open
      await sleep(50); const second = await payTo(g.url, c);
      expect(second).toBe(first); // the opener would succeed now: the answer must NOT change
      expect(g.calls()).toBe(1); // and the chain was not asked again for this claim
    } finally { await g.close(); }
  });
  it("a payment signed against the first (merchant) answer is accepted on the retry: 200, buyer served, no sale", async () => {
    const g = await flaky(1);
    try {
      const c = await mkClaim(); const buyer = c.buyer.toBase58();
      const headers = { [BRAND.claimHeader]: encodeClaimHeader(claimToWire(c)) };
      const r1 = await fetch(g.url, { headers }); const req = JSON.parse(Buffer.from(r1.headers.get("payment-required")!, "base64").toString());
      const pay = Buffer.from(JSON.stringify({ x402Version: 2, accepted: req.accepts[0], payload: { transaction: buyer }, resource: req.resource })).toString("base64");
      const r2 = await fetch(g.url, { headers: { ...headers, "payment-signature": pay } });
      expect(r2.status).toBe(200);
    } finally { await g.close(); }
  });
  it("when the first open succeeded the answer stays the sale vault on the retry (unchanged behaviour)", async () => {
    const g = await flaky(0);
    try { const c = await mkClaim(); const a = await payTo(g.url, c); await sleep(30); const b = await payTo(g.url, c); expect(a).toBe(salePda(programId, c.campaign, c.nonce).toBase58()); expect(b).toBe(a); } finally { await g.close(); }
  });
});

describe("an overloaded chain makes the gateway fail open quickly, not hold the buyer", () => {
  it("an open that takes longer than openTimeoutMs answers 'merchant' within the timeout, and a retry stays 'merchant' even if the open finishes later", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const opener: SaleOpener = { ensureOpen: async (c) => { await gate; return salePda(programId, c.campaign, c.nonce); } };
    const facilitator: any = { getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NET, extra: { feePayer: Keypair.generate().publicKey.toBase58() } }], extensions: [], signers: {} }), verify: async () => ({ isValid: true }), settle: async () => ({ success: true, transaction: "t", network: NET, payer: "p" }) };
    const events: GatewayEvent[] = [];
    const gw = createNouxGateway({ programId, cluster: "devnet", campaign, mint, network: NET, merchantPayTo: merchantPay, facilitator, connection: {} as any, campaigns: { get: async () => info() }, opener, openTimeoutMs: 300, routes: { "GET /data": { price: PRICE } }, now: () => 1_800_000_000, onEvent: (e: GatewayEvent) => events.push(e) } as any);
    const app = express(); app.use(gw.middleware); app.get("/data", (_q, r) => r.json({ ok: true }));
    const srv = await new Promise<import("node:http").Server>((res) => { const s = app.listen(0, () => res(s)); }); const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/data`;
    try {
      const c = await mkClaim(); const ask = async () => JSON.parse(Buffer.from((await fetch(url, { headers: { [BRAND.claimHeader]: encodeClaimHeader(claimToWire(c)) } })).headers.get("payment-required")!, "base64").toString()).accepts[0].payTo;
      const t = Date.now(); const first = await ask(); const took = Date.now() - t;
      expect(first).toBe(merchantPay.toBase58()); expect(took).toBeLessThan(2000); expect(events.some((e) => e.type === "sale_open_failed" && /longer than/.test((e as any).error))).toBe(true);
      release(); await sleep(50); expect(await ask()).toBe(first); // the open completed in the background: the answer still does not change
    } finally { release(); srv.closeAllConnections?.(); await new Promise<void>((r) => srv.close(() => r())); }
  });
});

describe("a refused payment says why", () => {
  async function paid(verify: (p: any) => Promise<any>, settle: (p: any) => Promise<any>) {
    const events: GatewayEvent[] = [];
    const facilitator: any = { getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NET, extra: { feePayer: Keypair.generate().publicKey.toBase58() } }], extensions: [], signers: {} }), verify, settle };
    const gw = createNouxGateway({ programId, cluster: "devnet", campaign, mint, network: NET, merchantPayTo: merchantPay, facilitator, connection: {} as any, campaigns: { get: async () => info() }, opener: { ensureOpen: async (c: SignedClaim) => salePda(programId, c.campaign, c.nonce) }, routes: { "GET /data": { price: PRICE } }, now: () => 1_800_000_000, onEvent: (e: GatewayEvent) => events.push(e) } as any);
    const app = express(); app.use(gw.middleware); app.get("/data", (_q, r) => r.json({ ok: true }));
    const srv = await new Promise<import("node:http").Server>((res) => { const s = app.listen(0, () => res(s)); }); const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/data`;
    const c = await mkClaim(); const h = { [BRAND.claimHeader]: encodeClaimHeader(claimToWire(c)) };
    const r1 = await fetch(url, { headers: h }); const req = JSON.parse(Buffer.from(r1.headers.get("payment-required")!, "base64").toString());
    const pay = Buffer.from(JSON.stringify({ x402Version: 2, accepted: req.accepts[0], payload: { transaction: c.buyer.toBase58() }, resource: req.resource })).toString("base64");
    const r2 = await fetch(url, { headers: { ...h, "payment-signature": pay } }); srv.closeAllConnections?.(); await new Promise<void>((r) => srv.close(() => r()));
    return { status: r2.status, events };
  }
  it("an invalid payment (the facilitator says isValid:false) is reported with the facilitator's reason", async () => {
    const { status, events } = await paid(async () => ({ isValid: false, invalidReason: "insufficient_funds" }), async () => ({ success: true, transaction: "t", network: NET, payer: "p" }));
    expect(status).toBe(402); expect(events.find((e) => e.type === "payment_invalid")).toMatchObject({ reason: "insufficient_funds" });
  });
  it("a verify call that throws is reported", async () => {
    const { status, events } = await paid(async () => { throw new Error("facilitator exploded"); }, async () => ({ success: true, transaction: "t", network: NET, payer: "p" }));
    expect(status).not.toBe(200); expect(events.some((e) => e.type === "payment_verify_failed" && /exploded/.test((e as any).error))).toBe(true);
  });
  it("a settle that fails is reported and the buyer is not served", async () => {
    const { status, events } = await paid(async (p: any) => ({ isValid: true, payer: p.payload.transaction }), async () => { throw new Error("settle exploded"); });
    expect(status).not.toBe(200); expect(events.some((e) => e.type === "payment_settle_failed" && /exploded/.test((e as any).error))).toBe(true);
  });
});
