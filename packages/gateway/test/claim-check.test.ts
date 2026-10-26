import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { LocalKeySigner, signClaim, claimToWire, BRAND } from "@axia/core";
import { evaluateClaim, encodeClaimHeader, decodeClaimHeader, MAX_CLAIM_HEADER_BYTES, type ClaimExpectations } from "../src";

const programId = Keypair.generate().publicKey, campaign = Keypair.generate().publicKey;
const attest = new LocalKeySigner(Keypair.generate().secretKey);
const NOW = 1_800_000_000, ROUTE_PRICE = 100_000n;
const expect_ = (o: Partial<ClaimExpectations> = {}): ClaimExpectations => ({ programId, cluster: "devnet", campaign, attributionKey: attest.publicKey, routePrice: ROUTE_PRICE, nowSec: NOW, minLifeSecs: 120, ...o });
async function header(over: Record<string, unknown> = {}, signer = attest) {
  const c = await signClaim(signer, { programId, cluster: "devnet", campaign, distributor: Keypair.generate().publicKey, buyer: Keypair.generate().publicKey, expiry: NOW + 600, price: ROUTE_PRICE, nonce: nacl.randomBytes(32), ...over } as any);
  return { c, h: encodeClaimHeader(claimToWire(c)) };
}

describe("evaluateClaim", () => {
  it("accepts a valid claim", async () => { const { h } = await header(); expect(evaluateClaim(h, expect_()).ok).toBe(true); });

  it("REJECTS a lower-priced claim (the discount attack)", async () => {
    const { h } = await header({ price: 1n }); // validly signed, but for 1 base unit while the route costs 100000
    expect(evaluateClaim(h, expect_())).toEqual({ ok: false, reason: "price_mismatch" });
  });
  it("rejects a higher-priced claim too: equality, not >=", async () => {
    const { h } = await header({ price: ROUTE_PRICE + 1n });
    expect(evaluateClaim(h, expect_())).toEqual({ ok: false, reason: "price_mismatch" });
  });
  it("a claim is honoured only on a route priced the same", async () => {
    const { h } = await header();
    expect(evaluateClaim(h, expect_({ routePrice: 50_000n }))).toEqual({ ok: false, reason: "price_mismatch" });
  });

  it("rejects a tampered message, tampered fields and swapped signatures", async () => {
    const { c } = await header();
    const w = claimToWire(c);
    const badMsg = Buffer.from(c.message); badMsg[120] ^= 1;
    expect(evaluateClaim(encodeClaimHeader({ ...w, message: badMsg.toString("base64") }), expect_())).toEqual({ ok: false, reason: "tampered" });
    expect(evaluateClaim(encodeClaimHeader({ ...w, price: "1" }), expect_())).toEqual({ ok: false, reason: "tampered" }); // field changed, signed message not
    expect(evaluateClaim(encodeClaimHeader({ ...w, buyer: Keypair.generate().publicKey.toBase58() }), expect_())).toEqual({ ok: false, reason: "tampered" });
    const sig = Buffer.from(c.signature); sig[0] ^= 1;
    expect(evaluateClaim(encodeClaimHeader({ ...w, signature: sig.toString("base64") }), expect_())).toEqual({ ok: false, reason: "tampered" });
  });
  it("rejects a claim signed by a key the CAMPAIGN does not trust (even if self-consistent)", async () => {
    const { h } = await header({}, new LocalKeySigner(Keypair.generate().secretKey));
    expect(evaluateClaim(h, expect_())).toEqual({ ok: false, reason: "wrong_attribution_key" });
  });
  it("rejects wrong program / cluster / campaign", async () => {
    expect(evaluateClaim((await header({ programId: Keypair.generate().publicKey })).h, expect_())).toEqual({ ok: false, reason: "wrong_program" });
    expect(evaluateClaim((await header({ cluster: "mainnet" })).h, expect_())).toEqual({ ok: false, reason: "wrong_cluster" });
    expect(evaluateClaim((await header({ campaign: Keypair.generate().publicKey })).h, expect_())).toEqual({ ok: false, reason: "wrong_campaign" });
  });
  it("rejects expired and about-to-expire claims (sale must outlive payment + hold)", async () => {
    expect(evaluateClaim((await header({ expiry: NOW - 1 })).h, expect_())).toEqual({ ok: false, reason: "expiring" });
    expect(evaluateClaim((await header({ expiry: NOW + 119 })).h, expect_())).toEqual({ ok: false, reason: "expiring" });
    expect(evaluateClaim((await header({ expiry: NOW + 120 })).h, expect_()).ok).toBe(true);
  });
  it("rejects self-referral", async () => {
    const k = Keypair.generate().publicKey;
    expect(evaluateClaim((await header({ distributor: k, buyer: k })).h, expect_())).toEqual({ ok: false, reason: "self_referral" });
  });
  it("handles missing, oversized and garbage headers without throwing", () => {
    expect(evaluateClaim(undefined, expect_())).toEqual({ ok: false, reason: "missing" });
    expect(evaluateClaim("x".repeat(MAX_CLAIM_HEADER_BYTES + 1), expect_())).toEqual({ ok: false, reason: "too_large" });
    for (const g of ["%%%", Buffer.from("not json").toString("base64"), Buffer.from("{}").toString("base64"), Buffer.from(JSON.stringify({ programId: 1 })).toString("base64")])
      expect(evaluateClaim(g, expect_())).toEqual({ ok: false, reason: "malformed" });
    expect(decodeClaimHeader(Buffer.from("[]").toString("base64")).ok).toBe(false);
  });
  it("header name comes from the brand constants", () => { expect(BRAND.claimHeader).toBe("x-axia-claim"); });
});
