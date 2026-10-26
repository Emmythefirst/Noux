import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { LocalKeySigner, signClaimRequest, claimFromWire, claimIsSelfConsistent, type CampaignInfo, type CampaignReader } from "@axia/core";
import { createPool, migrate } from "../src/db";
import { createApp } from "../src/app";
import { issueClaim, IssuanceError, type Deps } from "../src/issuance";
import { loadSigner } from "../src/keys";
import { loadConfig } from "../src/config";

const DB = process.env.DATABASE_URL_TEST ?? "postgres://postgres:devonly@localhost:54329/axia";
const PROGRAM = "AC6AtoRALLszNGNLmHte2UXKzCqBYQKhPdtq5qs77nkL";
const pool = createPool(DB);
const attest = Keypair.generate(); const signer = new LocalKeySigner(attest.secretKey);
const NOW = 1_800_000_000;
const campaignKey = Keypair.generate().publicKey;
const campaignInfo = (over: Partial<CampaignInfo> = {}): CampaignInfo => ({ address: campaignKey, merchant: Keypair.generate().publicKey, mint: Keypair.generate().publicKey, feeOwner: Keypair.generate().publicKey, attributionKey: signer.publicKey, cluster: "devnet", holdSecs: 15, commissionBps: 1500, feeBps: 100, commissionBudget: 1n, commissionSpent: 0n, settledCount: 0n, refundedCount: 0n, ...over });
let registry = new Map<string, CampaignInfo | null>();
const reader: CampaignReader = { get: async (a) => registry.get(a.toBase58()) ?? null };
const limits = { LIMIT_PER_DISTRIBUTOR_PER_MIN: 5, LIMIT_PER_BUYER_PER_MIN: 4, LIMIT_PER_CAMPAIGN_PER_MIN: 100, LIMIT_PER_IP_PER_MIN: 100 };
const deps = (over: Partial<Deps["cfg"]> = {}): Deps => ({ cfg: { CLUSTER: "devnet", PROGRAM_ID: PROGRAM, CLAIM_TTL_SECS: 600, MAX_PRICE_BASE_UNITS: 100_000_000n, ...limits, ...over }, pool, signer, campaigns: reader, now: () => NOW });

function request(over: Partial<{ campaign: PublicKey; distributor: PublicKey; buyer: Keypair; price: bigint; ts: number }> = {}) {
  const buyer = over.buyer ?? Keypair.generate();
  const a = { campaign: over.campaign ?? campaignKey, distributor: over.distributor ?? Keypair.generate().publicKey, buyer: buyer.publicKey, price: over.price ?? 100_000n, ts: over.ts ?? NOW };
  return { buyer, a, req: { campaign: a.campaign.toBase58(), distributor: a.distributor.toBase58(), buyer: a.buyer.toBase58(), price: a.price.toString(), ts: a.ts, buyerSignature: Buffer.from(signClaimRequest(buyer.secretKey, a)).toString("base64") } };
}
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as IssuanceError; } throw new Error("expected rejection"); };

beforeAll(async () => { await migrate(pool); });
beforeEach(async () => { await pool.query("TRUNCATE claim_issuance"); registry = new Map([[campaignKey.toBase58(), campaignInfo()]]); });
afterAll(async () => { await pool.end(); });

describe("claim issuance", () => {
  it("issues a signed, self-consistent claim bound to the buyer", async () => {
    const { a, req } = request();
    const w = await issueClaim(deps(), req, "1.1.1.1");
    const c = claimFromWire(w);
    expect(claimIsSelfConsistent(c)).toBe(true);
    expect(c.buyer.equals(a.buyer) && c.distributor.equals(a.distributor) && c.campaign.equals(a.campaign)).toBe(true);
    expect(c.price).toBe(100_000n); expect(c.expiry).toBe(NOW + 600); expect(c.cluster).toBe("devnet");
    expect(c.attributionKey.equals(signer.publicKey)).toBe(true);
    expect((await pool.query("SELECT count(*)::int n FROM claim_issuance")).rows[0].n).toBe(1);
  });
  it("uses a fresh server-chosen nonce every time", async () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 4; i++) nonces.add((await issueClaim(deps(), request().req, `9.9.9.${i}`)).nonce);
    expect(nonces.size).toBe(4);
  });
  it("rejects requests not signed by the buyer wallet (401)", async () => {
    const r = request(); const other = Keypair.generate();
    const forged = { ...r.req, buyerSignature: Buffer.from(signClaimRequest(other.secretKey, r.a)).toString("base64") };
    expect((await fail(issueClaim(deps(), forged, "1.1.1.1"))).status).toBe(401);
  });
  it("rejects a request whose fields were altered after signing (price/distributor)", async () => {
    const r = request();
    expect((await fail(issueClaim(deps(), { ...r.req, price: "1" }, "1.1.1.1"))).status).toBe(401);
    expect((await fail(issueClaim(deps(), { ...r.req, distributor: Keypair.generate().publicKey.toBase58() }, "1.1.1.1"))).status).toBe(401);
  });
  it("rejects stale and future-dated requests (replay of old requests)", async () => {
    expect((await fail(issueClaim(deps(), request({ ts: NOW - 120 }).req, "1.1.1.1"))).status).toBe(401);
    expect((await fail(issueClaim(deps(), request({ ts: NOW + 120 }).req, "1.1.1.1"))).status).toBe(401);
  });
  it("rejects self-referral (distributor == buyer)", async () => {
    const buyer = Keypair.generate();
    const e = await fail(issueClaim(deps(), request({ buyer, distributor: buyer.publicKey }).req, "1.1.1.1"));
    expect(e.code).toBe("self_referral");
  });
  it("rejects unknown campaigns, foreign attribution keys and wrong clusters (all 404)", async () => {
    expect((await fail(issueClaim(deps(), request({ campaign: Keypair.generate().publicKey }).req, "1.1.1.1"))).status).toBe(404);
    registry.set(campaignKey.toBase58(), campaignInfo({ attributionKey: Keypair.generate().publicKey }));
    expect((await fail(issueClaim(deps(), request().req, "1.1.1.1"))).status).toBe(404);
    registry.set(campaignKey.toBase58(), campaignInfo({ cluster: "mainnet" }));
    expect((await fail(issueClaim(deps(), request().req, "1.1.1.1"))).status).toBe(404);
  });
  it("enforces price bounds", async () => {
    expect((await fail(issueClaim(deps(), request({ price: 0n }).req, "1.1.1.1"))).code).toBe("bad_price");
    expect((await fail(issueClaim(deps(), request({ price: 100_000_001n }).req, "1.1.1.1"))).code).toBe("bad_price");
  });
  it("failed attempts do not consume rate-limit budget or write rows", async () => {
    for (let i = 0; i < 6; i++) await fail(issueClaim(deps(), { ...request().req, price: "oops" }, "1.1.1.1"));
    expect((await pool.query("SELECT count(*)::int n FROM claim_issuance")).rows[0].n).toBe(0);
  });
});

describe("rate limits (Postgres-backed)", () => {
  it("per distributor: the (limit+1)th request in a minute is refused", async () => {
    const dist = Keypair.generate().publicKey;
    for (let i = 0; i < 5; i++) await issueClaim(deps(), request({ distributor: dist }).req, `2.2.2.${i}`);
    const e = await fail(issueClaim(deps(), request({ distributor: dist }).req, "2.2.2.99"));
    expect(e.status).toBe(429); expect(e.message).toContain("distributor"); expect(e.retryAfterSec).toBeGreaterThan(0);
    await issueClaim(deps(), request().req, "2.2.2.50"); // a different distributor is unaffected
  });
  it("per buyer", async () => {
    const buyer = Keypair.generate();
    for (let i = 0; i < 4; i++) await issueClaim(deps(), request({ buyer }).req, `3.3.3.${i}`);
    expect((await fail(issueClaim(deps(), request({ buyer }).req, "3.3.3.99"))).message).toContain("buyer");
  });
  it("per campaign and per ip", async () => {
    for (let i = 0; i < 3; i++) await issueClaim(deps({ LIMIT_PER_CAMPAIGN_PER_MIN: 3 }), request().req, `4.4.4.${i}`);
    expect((await fail(issueClaim(deps({ LIMIT_PER_CAMPAIGN_PER_MIN: 3 }), request().req, "4.4.4.99"))).message).toContain("campaign");
    await pool.query("TRUNCATE claim_issuance");
    for (let i = 0; i < 3; i++) await issueClaim(deps({ LIMIT_PER_IP_PER_MIN: 3 }), request().req, "5.5.5.5");
    expect((await fail(issueClaim(deps({ LIMIT_PER_IP_PER_MIN: 3 }), request().req, "5.5.5.5"))).message).toContain("ip");
  });
  it("is atomic under concurrency: 25 parallel requests, limit 5 => exactly 5 succeed", async () => {
    const dist = Keypair.generate().publicKey;
    const res = await Promise.allSettled(Array.from({ length: 25 }, (_, i) => issueClaim(deps(), request({ distributor: dist }).req, `6.6.6.${i}`)));
    expect(res.filter((r) => r.status === "fulfilled").length).toBe(5);
    expect(res.filter((r) => r.status === "rejected" && (r.reason as IssuanceError).status === 429).length).toBe(20);
    expect((await pool.query("SELECT count(*)::int n FROM claim_issuance")).rows[0].n).toBe(5);
  });
  it("the limit lives in the database, not memory: a second service instance sees it", async () => {
    const dist = Keypair.generate().publicKey;
    for (let i = 0; i < 5; i++) await issueClaim(deps(), request({ distributor: dist }).req, `7.7.7.${i}`);
    const pool2 = createPool(DB); // "another process"
    try { expect((await fail(issueClaim({ ...deps(), pool: pool2 }, request({ distributor: dist }).req, "7.7.7.99"))).status).toBe(429); }
    finally { await pool2.end(); }
  });
});

describe("http layer", () => {
  const app = () => createApp(deps(), { trustProxy: true });
  const post = (b: unknown, headers: Record<string, string> = {}) => app().request("/v1/claims", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof b === "string" ? b : JSON.stringify(b) });
  it("201 with the claim; the response never contains any secret key material", async () => {
    const res = await post(request().req, { "x-forwarded-for": "8.8.8.8" });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(Buffer.from(attest.secretKey).toString("base64"));
    expect(text).not.toContain(Buffer.from(attest.secretKey).toString("hex"));
    expect(JSON.parse(text).claim.attributionKey).toBe(signer.publicKey.toBase58());
  });
  it("400 on junk, non-JSON and unknown fields", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ ...request().req, extra: 1 })).status).toBe(400);
  });
  it("429 carries Retry-After", async () => {
    const dist = Keypair.generate().publicKey;
    for (let i = 0; i < 5; i++) await post(request({ distributor: dist }).req, { "x-forwarded-for": `10.0.0.${i}` });
    const res = await post(request({ distributor: dist }).req, { "x-forwarded-for": "10.0.0.99" });
    expect(res.status).toBe(429); expect(res.headers.get("retry-after")).toBe("30");
  });
  it("healthz exposes only the PUBLIC attribution key", async () => {
    const res = await app().request("/healthz"); const t = await res.text();
    expect(JSON.parse(t).attributionKey).toBe(signer.publicKey.toBase58());
    expect(t).not.toContain(Buffer.from(attest.secretKey).toString("base64"));
  });
});

describe("key + config hygiene", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "axia-keys-"));
  it("refuses a key file readable by group/others, accepts mode 600", () => {
    const f = path.join(tmp, "k.json"); fs.writeFileSync(f, JSON.stringify([...attest.secretKey]), { mode: 0o644 }); fs.chmodSync(f, 0o644);
    expect(() => loadSigner({ ATTRIBUTION_KEY_FILE: f })).toThrow(/chmod 600/);
    fs.chmodSync(f, 0o600);
    expect(loadSigner({ ATTRIBUTION_KEY_FILE: f }).publicKey.equals(signer.publicKey)).toBe(true);
  });
  it("errors without a key, and bad config errors never echo values", () => {
    expect(() => loadSigner({})).toThrow(/no attribution key/);
    const secretish = "postgres://user:SUPERSECRETPASSWORD@h/db";
    try { loadConfig({ DATABASE_URL: secretish, RPC_URL: "not-a-url", PROGRAM_ID: PROGRAM, CLUSTER: "devnet" }); throw new Error("should fail"); }
    catch (e) { expect((e as Error).message).toContain("RPC_URL"); expect((e as Error).message).not.toContain("SUPERSECRETPASSWORD"); }
  });
});
