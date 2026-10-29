import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { LocalKeySigner, signClaimRequest, claimFromWire, claimIsSelfConsistent, type CampaignInfo } from "@noux/core";
import { createPool, migrate } from "../src/db";
import { createApp } from "../src/app";
import { issueClaim, IssuanceError, type Deps } from "../src/issuance";
import { loadRetiringSigners } from "../src/keys";

// Rotating the CLAIM SERVICE's own key must not strand the campaigns whose merchants have not switched yet: the service keeps signing for them with the old key.
const pool = createPool(process.env.DATABASE_URL_TEST ?? "postgres://postgres:devonly@localhost:54329/noux");
const NOW = 1_800_000_000, PROGRAM = "AC6AtoRALLszNGNLmHte2UXKzCqBYQKhPdtq5qs77nkL";
const oldKp = Keypair.generate(), newKp = Keypair.generate(), strangerKp = Keypair.generate();
const active = new LocalKeySigner(newKp.secretKey), retiring = new LocalKeySigner(oldKp.secretKey);
const pk = () => Keypair.generate().publicKey;
let trusts: PublicKey = oldKp.publicKey; const campaign = pk();
const info = (): CampaignInfo => ({ address: campaign, merchant: pk(), mint: pk(), feeOwner: pk(), attributionKey: trusts, cluster: "devnet", holdSecs: 15, commissionBps: 1500, feeBps: 100, commissionBudget: 1n, commissionSpent: 0n, settledCount: 0n, refundedCount: 0n, state: "active" });
const deps = (over: Partial<Deps> = {}): Deps => ({ cfg: { CLUSTER: "devnet", PROGRAM_ID: PROGRAM, CLAIM_TTL_SECS: 600, MAX_PRICE_BASE_UNITS: 100_000_000n, LIMIT_PER_DISTRIBUTOR_PER_MIN: 1000, LIMIT_PER_BUYER_PER_MIN: 1000, LIMIT_PER_CAMPAIGN_PER_MIN: 1000, LIMIT_PER_IP_PER_MIN: 1000 }, pool, signer: active, retiringSigners: [retiring], campaigns: { get: async () => info() }, now: () => NOW, ...over });
const req = () => { const buyer = Keypair.generate(), a = { campaign, distributor: pk(), buyer: buyer.publicKey, price: 100_000n, ts: NOW }; return { campaign: campaign.toBase58(), distributor: a.distributor.toBase58(), buyer: a.buyer.toBase58(), price: "100000", ts: NOW, buyerSignature: Buffer.from(signClaimRequest(buyer.secretKey, a)).toString("base64") }; };

beforeAll(async () => { await migrate(pool); });
beforeEach(async () => { await pool.query("TRUNCATE claim_issuance, idx_campaigns"); trusts = oldKp.publicKey; });
afterAll(async () => { await pool.end(); });

describe("loading retiring keys", () => {
  const sec = (k: Keypair) => bs58.encode(k.secretKey);
  it("none configured: no retiring signers; two configured: both loaded, in order", () => {
    expect(loadRetiringSigners({}, active)).toEqual([]); expect(loadRetiringSigners({ ATTRIBUTION_RETIRING_KEYS_B58: "  " }, active)).toEqual([]);
    const l = loadRetiringSigners({ ATTRIBUTION_RETIRING_KEYS_B58: `${sec(oldKp)}, ${sec(strangerKp)}` }, active); expect(l.map((s) => s.publicKey.toBase58())).toEqual([oldKp.publicKey.toBase58(), strangerKp.publicKey.toBase58()]);
  });
  it("refuses garbage, the active key, duplicates and more than three, and the message never contains key material", () => {
    const cases: [string, RegExp][] = [["not-a-key!!", /#1 is not a valid/], [sec(newKp), /same as the active/], [`${sec(oldKp)},${sec(oldKp)}`, /listed twice/], [[1, 2, 3, 4].map(() => sec(Keypair.generate())).join(","), /at most 3/]];
    for (const [v, re] of cases) { let msg = ""; try { loadRetiringSigners({ ATTRIBUTION_RETIRING_KEYS_B58: v }, active); } catch (e) { msg = String((e as Error).message); } expect(msg).toMatch(re); expect(msg).not.toContain(v.split(",")[0]); }
  });
});

describe("issuing claims during a key rotation of the service", () => {
  it("a campaign still trusting the OLD key gets claims signed by the old key (nothing is stranded)", async () => {
    trusts = oldKp.publicKey; const c = claimFromWire(await issueClaim(deps(), req(), "1.1.1.1"));
    expect(c.attributionKey.equals(oldKp.publicKey)).toBe(true); expect(claimIsSelfConsistent(c)).toBe(true);
  });
  it("a campaign that moved to the NEW key gets claims signed by the new key", async () => {
    trusts = newKp.publicKey; const c = claimFromWire(await issueClaim(deps(), req(), "1.1.1.1"));
    expect(c.attributionKey.equals(newKp.publicKey)).toBe(true); expect(claimIsSelfConsistent(c)).toBe(true);
  });
  it("the switch happens with no restart: the same campaign, after its merchant rotates, is signed with the new key", async () => {
    trusts = oldKp.publicKey; const before = claimFromWire(await issueClaim(deps(), req(), "1.1.1.1"));
    trusts = newKp.publicKey; const after = claimFromWire(await issueClaim(deps(), req(), "1.1.1.2"));
    expect(before.attributionKey.toBase58()).not.toBe(after.attributionKey.toBase58()); expect(after.attributionKey.equals(newKp.publicKey)).toBe(true);
  });
  it("a campaign trusting some OTHER key is still refused (404): the service never signs for a key it does not hold", async () => {
    trusts = strangerKp.publicKey; const e = (await issueClaim(deps(), req(), "1.1.1.1").catch((x) => x)) as IssuanceError; expect(e.status).toBe(404); expect(e.code).toBe("campaign_not_found");
  });
  it("without the retiring key (old behaviour) the old-key campaign IS refused: the overlap is what saves it", async () => {
    trusts = oldKp.publicKey; const e = (await issueClaim(deps({ retiringSigners: [] }), req(), "1.1.1.1").catch((x) => x)) as IssuanceError; expect(e.status).toBe(404);
  });
});

describe("GET /v1/claim-service shows the migration", () => {
  const camp = (key: PublicKey, state = "active") => pool.query(`INSERT INTO idx_campaigns (address, merchant, mint, fee_owner, attribution_key, cluster, hold_secs, commission_bps, fee_bps, commission_budget, commission_spent, settled_count, refunded_count, state) VALUES ($1,$2,$3,$4,$5,'devnet',15,1500,100,1,0,0,0,$6)`, [pk().toBase58(), pk().toBase58(), pk().toBase58(), pk().toBase58(), key.toBase58(), state]);
  const mk = () => createApp(deps(), { trustProxy: false, public: { pool, campaigns: { get: async () => null } as any, cluster: "devnet", programId: PROGRAM, decimals: 6, now: () => NOW } });
  it("lists the active key, the retiring keys and how many (non-ended) campaigns still trust each, so an operator knows when the old key can go", async () => {
    await camp(oldKp.publicKey); await camp(oldKp.publicKey); await camp(newKp.publicKey); await camp(oldKp.publicKey, "ended"); await camp(strangerKp.publicKey);
    const r = await (await mk().request("/v1/claim-service")).json() as any;
    expect(r.attributionKey).toBe(newKp.publicKey.toBase58()); expect(r.retiringKeys).toEqual([oldKp.publicKey.toBase58()]);
    expect(r.campaignsByKey).toEqual({ [newKp.publicKey.toBase58()]: 1, [oldKp.publicKey.toBase58()]: 2 });
  });
  it("with nobody left on the old key its count is 0, and no secret key appears anywhere in the response", async () => {
    const text = await (await mk().request("/v1/claim-service")).text(); const r = JSON.parse(text);
    expect(r.campaignsByKey[oldKp.publicKey.toBase58()]).toBe(0);
    for (const kp of [oldKp, newKp]) { expect(text).not.toContain(bs58.encode(kp.secretKey)); expect(text).not.toContain(JSON.stringify(Array.from(kp.secretKey))); }
  });
});
