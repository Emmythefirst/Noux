import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { LocalKeySigner, signClaim, claimToWire, salePda, BRAND, type CampaignInfo, type SignedClaim } from "@noux/core";
import { encodeClaimHeader, type SaleOpener, type SaleSettler } from "@noux/gateway";
import { loadConfig } from "../src/config";
import { createDemoApp, ROUTES, SAMPLE_NOTICE } from "../src/app";

const NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const programId = Keypair.generate().publicKey, campaign = Keypair.generate().publicKey, mint = Keypair.generate().publicKey, merchantPay = Keypair.generate().publicKey;
const attest = new LocalKeySigner(Keypair.generate().secretKey);
const info = (): CampaignInfo => ({ address: campaign, merchant: merchantPay, mint, feeOwner: Keypair.generate().publicKey, attributionKey: attest.publicKey, cluster: "devnet", holdSecs: 15, commissionBps: 1500, feeBps: 100, commissionBudget: 1n, commissionSpent: 0n, settledCount: 0n, refundedCount: 0n, state: "active" });

let server: Server | undefined;
afterEach(async () => { await new Promise((r) => (server ? server.close(() => r(null)) : r(null))); server = undefined; });

async function boot(over: { payer?: string } = {}) {
  const opened: SignedClaim[] = [], settled: SignedClaim[] = []; let payer = over.payer ?? "";
  const opener: SaleOpener = { ensureOpen: async (c) => { opened.push(c); return salePda(programId, c.campaign, c.nonce); } };
  const settler: SaleSettler = { settle: async (c) => { settled.push(c); return "S"; }, refund: async () => "R" };
  const facilitator: any = {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NET, extra: { feePayer: Keypair.generate().publicKey.toBase58() } }], extensions: [], signers: {} }),
    verify: async () => ({ isValid: true, payer }), settle: async () => ({ success: true, payer, transaction: "TX", network: NET }),
  };
  const { app } = createDemoApp({
    cluster: "devnet", network: NET, claimsApiUrl: "https://api.example", campaign, mint, merchantPayTo: merchantPay, now: () => new Date("2026-10-27T10:00:00Z"),
    gateway: { programId, cluster: "devnet", campaign, mint, network: NET, merchantPayTo: merchantPay, facilitator, connection: {} as any, campaigns: { get: async () => info() }, opener, settler, now: () => 1_800_000_000 },
  });
  server = await new Promise<Server>((res) => { const s = app.listen(0, () => res(s)); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, opened, settled, setPayer: (p: string) => { payer = p; } };
}
const claimFor = (price: bigint) => signClaim(attest, { programId, cluster: "devnet", campaign, distributor: Keypair.generate().publicKey, buyer: Keypair.generate().publicKey, expiry: 1_800_000_600, price, nonce: nacl.randomBytes(32) });
const requirements = async (res: Response) => JSON.parse(Buffer.from(res.headers.get("payment-required")!, "base64").toString());
async function payFor(url: string, path: string, headers: Record<string, string> = {}) {
  const r1 = await fetch(url + path, { headers }); const req = await requirements(r1);
  const payment = Buffer.from(JSON.stringify({ x402Version: 2, accepted: req.accepts[0], payload: { transaction: "AAAA" }, resource: req.resource })).toString("base64");
  return fetch(url + path, { headers: { ...headers, "payment-signature": payment } });
}

describe("config", () => {
  const base = { RPC_URL: "https://rpc.example", PROGRAM_ID: programId.toBase58(), CLUSTER: "devnet", CAMPAIGN: campaign.toBase58(), MINT: mint.toBase58(), MERCHANT_PAYTO: merchantPay.toBase58(), GATEWAY_PAYER_B58: "x".repeat(60), CDP_API_KEY_ID: "id", CDP_API_KEY_SECRET: "s" };
  it("parses, derives the CAIP-2 network and defaults sensibly", () => {
    const c = loadConfig(base); expect(c.NETWORK).toBe(NET); expect(c.FACILITATOR).toBe("cdp"); expect(c.CLAIMS_API_URL).toMatch(/^https:/);
    expect(loadConfig({ ...base, CLUSTER: "mainnet" }).NETWORK).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  });
  it("requires CDP credentials only when the CDP facilitator is selected", () => {
    expect(() => loadConfig({ ...base, CDP_API_KEY_ID: undefined })).toThrow(/CDP_API_KEY_ID/);
    expect(loadConfig({ ...base, FACILITATOR: "x402.org", CDP_API_KEY_ID: undefined, CDP_API_KEY_SECRET: undefined }).FACILITATOR).toBe("x402.org");
  });
  it("accepts the CDP secret as hex and decodes it to the exact original (immune to paste mangling)", () => {
    const secret = "ab+cd/ef==+Zz09";
    const hex = Buffer.from(secret, "utf8").toString("hex");
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(loadConfig({ ...base, CDP_API_KEY_SECRET: undefined, CDP_API_KEY_SECRET_HEX: hex }).CDP_API_KEY_SECRET).toBe(secret);
    expect(loadConfig({ ...base, CDP_API_KEY_SECRET: "corrupted", CDP_API_KEY_SECRET_HEX: hex }).CDP_API_KEY_SECRET).toBe(secret); // hex wins
    expect(() => loadConfig({ ...base, CDP_API_KEY_SECRET: undefined, CDP_API_KEY_SECRET_HEX: "zz" })).toThrow(/CDP_API_KEY_SECRET_HEX/);
    expect(() => loadConfig({ ...base, CDP_API_KEY_SECRET: undefined })).toThrow(/CDP_API_KEY_ID/); // neither form given
  });
  it("rejects unknown clusters and never echoes secret values in errors", () => {
    expect(() => loadConfig({ ...base, CLUSTER: "testnet" })).toThrow(/CLUSTER/);
    try { loadConfig({ ...base, RPC_URL: "not a url", GATEWAY_PAYER_B58: "SUPERSECRETKEYMATERIAL" }); throw new Error("no throw"); }
    catch (e) { expect((e as Error).message).toContain("RPC_URL"); expect((e as Error).message).not.toContain("SUPERSECRETKEYMATERIAL"); }
  });
});

describe("free endpoints", () => {
  it("healthz and info describe the SAMPLE service, routes, prices and the claim header", async () => {
    const { url } = await boot();
    expect((await (await fetch(url + "/healthz")).json()).sample).toBe(true);
    const i = await (await fetch(url + "/v1/info")).json();
    expect(i).toMatchObject({ sample: true, cluster: "devnet", network: NET, mint: mint.toBase58(), campaign: campaign.toBase58(), decimals: 6 });
    expect(i.routes).toEqual([{ route: "GET /sample/brief", price: "100000", displayPrice: "$0.10", description: expect.any(String) }, { route: "GET /sample/quote", price: "30000", displayPrice: "$0.03", description: expect.any(String) }]);
    expect(i.claims.header).toBe(BRAND.claimHeader); expect(i.claims.api).toBe("https://api.example/v1/claims");
    expect(JSON.stringify(i)).not.toMatch(/secret|private|keypair/i);
  });
  it("the landing page says SAMPLE prominently; JSON clients are redirected to /v1/info", async () => {
    const { url } = await boot();
    const html = await (await fetch(url + "/", { headers: { accept: "text/html" } })).text(); expect(html).toMatch(/SAMPLE SERVICE/);
    const j = await fetch(url + "/", { headers: { accept: "application/json" }, redirect: "manual" }); expect(j.status).toBe(302); expect(j.headers.get("location")).toBe("/v1/info");
  });
  it("sets nosniff, hides x-powered-by, exposes the x402 headers to browsers, answers preflight", async () => {
    const { url } = await boot();
    const r = await fetch(url + "/healthz"); expect(r.headers.get("x-content-type-options")).toBe("nosniff"); expect(r.headers.get("x-powered-by")).toBeNull();
    const p = await fetch(url + "/sample/brief"); expect(p.headers.get("access-control-expose-headers")).toContain("payment-required");
    const o = await fetch(url + "/sample/brief", { method: "OPTIONS" }); expect(o.status).toBe(204); expect(o.headers.get("access-control-allow-headers")).toContain(BRAND.claimHeader);
    // a browser buyer (the x402 fetch client) preflights with these request headers; a missing one makes the whole payment fail in the browser
    for (const h of ["payment-signature", "access-control-expose-headers", "content-type"]) expect(o.headers.get("access-control-allow-headers")).toContain(h);
  });
});

describe("paid endpoints", () => {
  it("answer 402 with the route's real price, asset and the merchant as payee when called without a claim", async () => {
    const { url, opened } = await boot();
    for (const [route, v] of Object.entries(ROUTES)) {
      const r = await fetch(url + "/" + route.split(" ")[1].slice(1)); expect(r.status).toBe(402);
      const a = (await requirements(r)).accepts[0]; expect(a.amount).toBe(v.price.toString()); expect(a.asset).toBe(mint.toBase58()); expect(a.payTo).toBe(merchantPay.toBase58());
    }
    expect(opened).toHaveLength(0);
  });
  it("a valid claim at the route price switches the payee to the per-sale vault and opens the sale", async () => {
    const { url, opened } = await boot(); const c = await claimFor(ROUTES["GET /sample/brief"].price);
    const r = await fetch(url + "/sample/brief", { headers: { [BRAND.claimHeader]: encodeClaimHeader(claimToWire(c)) } });
    expect((await requirements(r)).accepts[0].payTo).toBe(salePda(programId, campaign, c.nonce).toBase58()); expect(opened).toHaveLength(1);
  });
  it("a claim priced for ANOTHER route is refused (brief claim on the cheaper quote route)", async () => {
    const { url, opened } = await boot(); const c = await claimFor(ROUTES["GET /sample/brief"].price);
    const r = await fetch(url + "/sample/quote", { headers: { [BRAND.claimHeader]: encodeClaimHeader(claimToWire(c)) } });
    const a = (await requirements(r)).accepts[0]; expect(a.payTo).toBe(merchantPay.toBase58()); expect(a.amount).toBe("30000"); expect(opened).toHaveLength(0);
  });
  it("paid responses are labelled SAMPLE and deterministic per day", async () => {
    const { url, setPayer } = await boot(); setPayer(Keypair.generate().publicKey.toBase58());
    const a = await (await payFor(url, "/sample/brief")).json(), b = await (await payFor(url, "/sample/brief")).json();
    expect(a).toMatchObject({ sample: true, notice: SAMPLE_NOTICE, date: "2026-10-27" }); expect(a.sentiment).toBe(b.sentiment);
  });
  it("the quote endpoint sanitises the symbol (no markup reflected)", async () => {
    const { url, setPayer } = await boot(); setPayer(Keypair.generate().publicKey.toBase58());
    const q = await (await payFor(url, "/sample/quote?symbol=" + encodeURIComponent("<script>alert(1)</script>"))).json();
    expect(q.symbol).toBe("SCRIPTALER"); // letters/digits only, then cut to 10 chars
    expect(q.symbol).toMatch(/^[A-Z0-9]{1,10}$/); expect(JSON.stringify(q)).not.toContain("<");
    expect((await (await payFor(url, "/sample/quote?symbol=")).json()).symbol).toBe("SOL");
  });
  it("end to end with a claim: bound buyer pays => 200 and the sale is settled after delivery; another payer is refused", async () => {
    const h = await boot(); const c = await claimFor(ROUTES["GET /sample/brief"].price); const hdr = { [BRAND.claimHeader]: encodeClaimHeader(claimToWire(c)) };
    h.setPayer(Keypair.generate().publicKey.toBase58());
    expect((await payFor(h.url, "/sample/brief", hdr)).status).toBe(402); expect(h.settled).toHaveLength(0);
    h.setPayer(c.buyer.toBase58());
    const ok = await payFor(h.url, "/sample/brief", hdr); expect(ok.status).toBe(200); expect((await ok.json()).sample).toBe(true); expect(h.settled).toHaveLength(1);
  });
});

import { scrub } from "../src/app";
describe("operator diagnostics and failure mapping", () => {
  it("scrub removes api keys, bearer tokens and known secrets, and truncates", () => {
    const s = scrub("GET https://rpc.example/?api-key=ABC123SECRET&x=1 failed Bearer eyJhbGciOi.payload.sig; secret=SUPERSECRETVALUE tail", ["SUPERSECRETVALUE"]);
    expect(s).not.toContain("ABC123SECRET"); expect(s).not.toContain("eyJhbGciOi"); expect(s).not.toContain("SUPERSECRETVALUE"); expect(s).toContain("REDACTED");
    expect(scrub("x".repeat(500)).length).toBeLessThanOrEqual(160);
  });
  it("/v1/status serves sanitised diagnostics (cached) when configured, 404 otherwise", async () => {
    let calls = 0;
    const mk = (diagnose?: () => Promise<Record<string, unknown>>) => createDemoApp({
      cluster: "devnet", network: NET, claimsApiUrl: "https://api.example", campaign, mint, merchantPayTo: merchantPay, diagnose,
      gateway: { programId, cluster: "devnet", campaign, mint, network: NET, merchantPayTo: merchantPay, connection: {} as any, campaigns: { get: async () => info() }, opener: { ensureOpen: async () => Keypair.generate().publicKey },
        facilitator: { getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NET, extra: { feePayer: Keypair.generate().publicKey.toBase58() } }], extensions: [], signers: {} }), verify: async () => ({ isValid: true }), settle: async () => ({ success: true, transaction: "t", network: NET, payer: "p" }) } as any },
    }).app;
    const a = mk(async () => { calls++; return { rpc: { ok: true } }; });
    server = await new Promise<Server>((res) => { const s = a.listen(0, () => res(s)); }); const u = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(await (await fetch(u + "/v1/status")).json()).toEqual({ rpc: { ok: true } }); await fetch(u + "/v1/status"); expect(calls).toBe(1); // cached
    expect((await fetch(u + "/v1/status")).headers.get("cache-control")).toBe("no-store");
    await new Promise((r) => server!.close(() => r(null)));
    server = await new Promise<Server>((res) => { const s = mk().listen(0, () => res(s)); }); expect((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/status`)).status).toBe(404);
  });
  it("an unreachable facilitator yields 503 + Retry-After on paid routes, while free routes still work", async () => {
    const { app } = createDemoApp({
      cluster: "devnet", network: NET, claimsApiUrl: "https://api.example", campaign, mint, merchantPayTo: merchantPay,
      gateway: { programId, cluster: "devnet", campaign, mint, network: NET, merchantPayTo: merchantPay, connection: {} as any, campaigns: { get: async () => info() }, opener: { ensureOpen: async () => Keypair.generate().publicKey },
        facilitator: { getSupported: async () => { throw new TypeError("fetch failed"); }, verify: async () => { throw new TypeError("fetch failed"); }, settle: async () => { throw new TypeError("fetch failed"); } } as any,
        resilient: { sleep: async () => {}, backoffMs: () => 0, maxAttempts: 2 } },
    });
    server = await new Promise<Server>((res) => { const s = app.listen(0, () => res(s)); }); const u = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const r = await fetch(u + "/sample/brief"); expect(r.status).toBe(503); expect(r.headers.get("retry-after")).toBe("10"); expect((await r.json()).error.code).toBe("facilitator_unavailable");
    expect((await fetch(u + "/healthz")).status).toBe(200);
  });
});
