import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { inspect } from "node:util";
import { BRAND, CLAIM_TAG, PROGRAM_CLAIM_TAG_LEN } from "../src";
import {
  buildClaimMessage, signClaim, verifyClaimSignature, claimIsSelfConsistent, LocalKeySigner, claimToWire, claimFromWire,
  signClaimRequest, verifyClaimRequest, CLAIM_MESSAGE_LEN, salePda, campaignPda,
} from "../src";

const programId = new PublicKey("AC6AtoRALLszNGNLmHte2UXKzCqBYQKhPdtq5qs77nkL");
const mk = () => Keypair.generate().publicKey;
const base = () => ({ programId, cluster: "devnet", campaign: mk(), distributor: mk(), buyer: mk(), expiry: 1_800_000_000, price: 100_000n, nonce: nacl.randomBytes(32) });

// Independent re-implementation of the layout the on-chain program checks (same as spike/e2e.mjs claimMsg).
function referenceMessage(p: ReturnType<typeof base>) {
  const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
  const i64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
  return Buffer.concat([Buffer.from(CLAIM_TAG), programId.toBuffer(), Buffer.from("devnet\0\0"), p.campaign.toBuffer(), p.distributor.toBuffer(), p.buyer.toBuffer(), i64(p.expiry), u64(p.price), Buffer.from(p.nonce)]);
}

describe("brand", () => {
  it("claim tag length equals the one compiled into the program (rename guard)", () => {
    expect(Buffer.byteLength(CLAIM_TAG)).toBe(PROGRAM_CLAIM_TAG_LEN);
    expect(CLAIM_TAG.startsWith(BRAND.tagPrefix)).toBe(true);
  });
});

describe("claim message", () => {
  it("matches the on-chain layout byte for byte and is 197 bytes", () => {
    const p = base();
    const m = buildClaimMessage(p);
    expect(m.length).toBe(CLAIM_MESSAGE_LEN);
    expect(m.equals(referenceMessage(p))).toBe(true);
  });
  it("changes when ANY field changes (no field is unbound)", () => {
    const p = base(); const m = buildClaimMessage(p).toString("hex");
    for (const mut of [
      { campaign: mk() }, { distributor: mk() }, { buyer: mk() }, { expiry: p.expiry + 1 }, { price: p.price + 1n },
      { nonce: nacl.randomBytes(32) }, { cluster: "mainnet" }, { programId: mk() },
    ]) expect(buildClaimMessage({ ...p, ...mut }).toString("hex")).not.toBe(m);
  });
  it("rejects bad inputs", () => {
    const p = base();
    expect(() => buildClaimMessage({ ...p, nonce: new Uint8Array(31) })).toThrow();
    expect(() => buildClaimMessage({ ...p, price: 0n })).toThrow();
    expect(() => buildClaimMessage({ ...p, cluster: "" })).toThrow();
    expect(() => buildClaimMessage({ ...p, cluster: "toolongcluster" })).toThrow();
  });
});

describe("signing", () => {
  const signer = new LocalKeySigner(Keypair.generate().secretKey);
  it("signs and verifies; tampering breaks it", async () => {
    const c = await signClaim(signer, base());
    expect(verifyClaimSignature(c)).toBe(true);
    expect(claimIsSelfConsistent(c)).toBe(true);
    expect(claimIsSelfConsistent({ ...c, price: c.price + 1n })).toBe(false); // fields no longer match the signed message
    const forged = Buffer.from(c.message); forged[100] ^= 1;
    expect(verifyClaimSignature({ ...c, message: forged })).toBe(false);
    expect(verifyClaimSignature({ ...c, attributionKey: mk() })).toBe(false);
  });
  it("round-trips through the JSON wire format", async () => {
    const c = await signClaim(signer, base());
    const back = claimFromWire(JSON.parse(JSON.stringify(claimToWire(c))));
    expect(back.message.equals(c.message)).toBe(true);
    expect(claimIsSelfConsistent(back)).toBe(true);
  });
  it("never exposes the secret key via JSON or inspect", () => {
    const kp = Keypair.generate(); const s = new LocalKeySigner(kp.secretKey);
    const secretHex = Buffer.from(kp.secretKey).toString("hex"), secretB64 = Buffer.from(kp.secretKey).toString("base64");
    for (const out of [JSON.stringify(s), inspect(s, { showHidden: true, depth: 5 }), String(s)]) {
      expect(out).not.toContain(secretHex); expect(out).not.toContain(secretB64);
    }
  });
});

describe("buyer-signed claim request", () => {
  const buyer = Keypair.generate();
  const a = { campaign: mk(), distributor: mk(), buyer: buyer.publicKey, price: 100_000n, ts: 1_800_000_000 };
  it("accepts the buyer's signature within the skew window", () => {
    const sig = signClaimRequest(buyer.secretKey, a);
    expect(verifyClaimRequest(a, sig, a.ts + 5)).toBe(true);
  });
  it("rejects stale, future, other-signer and altered requests", () => {
    const sig = signClaimRequest(buyer.secretKey, a);
    expect(verifyClaimRequest(a, sig, a.ts + 61)).toBe(false);
    expect(verifyClaimRequest(a, sig, a.ts - 61)).toBe(false);
    expect(verifyClaimRequest(a, signClaimRequest(Keypair.generate().secretKey, a), a.ts)).toBe(false);
    expect(verifyClaimRequest({ ...a, price: 1n }, sig, a.ts)).toBe(false);
    expect(verifyClaimRequest({ ...a, distributor: mk() }, sig, a.ts)).toBe(false);
  });
});

describe("pda", () => {
  it("is deterministic and nonce-specific", () => {
    const c = campaignPda(programId, mk(), 7n); const n = nacl.randomBytes(32);
    expect(salePda(programId, c, n).equals(salePda(programId, c, n))).toBe(true);
    expect(salePda(programId, c, n).equals(salePda(programId, c, nacl.randomBytes(32)))).toBe(false);
    expect(PublicKey.isOnCurve(salePda(programId, c, n).toBytes())).toBe(false);
  });
});
