import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Keypair } from "@solana/web3.js";
import { LocalKeySigner } from "@noux/core";
import { createPool, migrate } from "../src/db";
import { createApp } from "../src/app";
import { clientIpFrom } from "../src/client-ip";

describe("clientIpFrom: the client is the entry our own proxy appended (counted from the right)", () => {
  it("one trusted proxy: the rightmost entry; anything the client put on the left is ignored", () => {
    expect(clientIpFrom("203.0.113.9", 1, "10.0.0.1")).toBe("203.0.113.9");
    expect(clientIpFrom("6.6.6.6, 7.7.7.7, 203.0.113.9", 1, "10.0.0.1")).toBe("203.0.113.9");
  });
  it("two trusted proxies (e.g. a CDN then a load balancer): the second from the right", () => {
    expect(clientIpFrom("6.6.6.6, 203.0.113.9, 172.16.0.5", 2, "10.0.0.1")).toBe("203.0.113.9");
  });
  it("fewer entries than trusted hops: do not guess, use the connection's own address", () => {
    expect(clientIpFrom("203.0.113.9", 2, "10.0.0.1")).toBe("10.0.0.1");
  });
  it("no header, or no trusted proxy configured: the connection's own address", () => {
    expect(clientIpFrom(undefined, 1, "10.0.0.1")).toBe("10.0.0.1"); expect(clientIpFrom("1.2.3.4", 0, "10.0.0.1")).toBe("10.0.0.1");
  });
  it("accepts IPv6; rejects anything that is not an address (it becomes a map key)", () => {
    expect(clientIpFrom("2001:db8::1", 1, "10.0.0.1")).toBe("2001:db8::1");
    expect(clientIpFrom("<script>alert(1)</script>", 1, "10.0.0.1")).toBe("10.0.0.1");
    expect(clientIpFrom("x".repeat(500), 1, undefined)).toBe("unknown");
  });
});

describe("the per-IP read limit cannot be walked around by forging X-Forwarded-For", () => {
  const pool = createPool(process.env.DATABASE_URL_TEST ?? "postgres://postgres:devonly@localhost:54329/noux");
  beforeAll(async () => { await migrate(pool); });
  afterAll(async () => { await pool.end(); });
  const kp = () => Keypair.generate().publicKey.toBase58();
  const mk = (hops = 1) => createApp({ cfg: { CLUSTER: "devnet", PROGRAM_ID: kp(), CLAIM_TTL_SECS: 600, MAX_PRICE_BASE_UNITS: 1n, LIMIT_PER_DISTRIBUTOR_PER_MIN: 1, LIMIT_PER_BUYER_PER_MIN: 1, LIMIT_PER_CAMPAIGN_PER_MIN: 1, LIMIT_PER_IP_PER_MIN: 1 }, pool, signer: new LocalKeySigner(Keypair.generate().secretKey), campaigns: { get: async () => null } as any },
    { trustProxy: true, proxyHops: hops, readLimitPerMin: 3, public: { pool, campaigns: { get: async () => null } as any, cluster: "devnet", programId: kp(), decimals: 6, now: () => 1_800_000_000 } });
  const hit = async (app: ReturnType<typeof mk>, xff: string) => (await app.request("/v1/index", { headers: { "x-forwarded-for": xff } })).status;

  it("rotating a forged leftmost entry does NOT reset the limit: the 4th request from the same real address is refused", async () => {
    const app = mk(); const real = "203.0.113.77"; const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push(await hit(app, `10.${i}.${i}.${i}, ${real}`)); // a different forged identity each time, same real client
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });
  it("different real clients keep separate allowances", async () => {
    const app = mk(); for (let i = 0; i < 3; i++) await hit(app, "203.0.113.1"); expect(await hit(app, "203.0.113.1")).toBe(429); expect(await hit(app, "203.0.113.2")).toBe(200);
  });
  it("/v1/whoami tells an operator what the service believes: address, forwarded entries, trusted hops", async () => {
    const r = await mk().request("/v1/whoami", { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" } });
    expect(await r.json()).toMatchObject({ ip: "203.0.113.9", forwardedEntries: 2, proxyHops: 1, trustProxy: true });
  });
});
