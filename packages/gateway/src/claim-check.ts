import { PublicKey } from "@solana/web3.js";
import { claimFromWire, claimIsSelfConsistent, type ClaimWire, type SignedClaim } from "@noux/core";

export const MAX_CLAIM_HEADER_BYTES = 2048;

export type ClaimRejection =
  | "missing" | "too_large" | "malformed" | "tampered" | "wrong_program" | "wrong_cluster" | "wrong_campaign"
  | "wrong_attribution_key" | "price_mismatch" | "expiring" | "self_referral";

export type ClaimDecision = { ok: true; claim: SignedClaim } | { ok: false; reason: ClaimRejection };

export interface ClaimExpectations {
  programId: PublicKey;
  cluster: string;
  campaign: PublicKey;
  /** The attribution key the CAMPAIGN trusts, read from chain (never from the claim itself). */
  attributionKey: PublicKey;
  /** Price of the route being called, in base units. The claim must equal it exactly. */
  routePrice: bigint;
  nowSec: number;
  /** A claim that expires sooner than this is refused: the sale must outlive the payment + hold. */
  minLifeSecs: number;
}

/** Header value = base64(JSON(ClaimWire)). */
export function encodeClaimHeader(w: ClaimWire): string { return Buffer.from(JSON.stringify(w)).toString("base64"); }

export function decodeClaimHeader(value: string | undefined): { ok: true; wire: ClaimWire } | { ok: false; reason: ClaimRejection } {
  if (!value) return { ok: false, reason: "missing" };
  if (value.length > MAX_CLAIM_HEADER_BYTES) return { ok: false, reason: "too_large" };
  try {
    const w = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    for (const k of ["programId", "cluster", "campaign", "distributor", "buyer", "price", "nonce", "attributionKey", "message", "signature"]) if (typeof w?.[k] !== "string") throw 0;
    if (!Number.isInteger(w.expiry)) throw 0;
    return { ok: true, wire: w as ClaimWire };
  } catch { return { ok: false, reason: "malformed" }; }
}

/**
 * Pure decision: may this claim be honoured on this route? Anything that fails means "treat the call as a plain
 * purchase": the merchant is paid in full and no sale/commission exists. Checks the cheap, local things first.
 */
export function evaluateClaim(headerValue: string | undefined, e: ClaimExpectations): ClaimDecision {
  const d = decodeClaimHeader(headerValue);
  if (!d.ok) return d;
  let c: SignedClaim;
  try { c = claimFromWire(d.wire); } catch { return { ok: false, reason: "malformed" }; }
  if (!claimIsSelfConsistent(c)) return { ok: false, reason: "tampered" }; // fields must equal the signed message AND the signature must verify
  if (!c.programId.equals(e.programId)) return { ok: false, reason: "wrong_program" };
  if (c.cluster !== e.cluster) return { ok: false, reason: "wrong_cluster" };
  if (!c.campaign.equals(e.campaign)) return { ok: false, reason: "wrong_campaign" };
  if (!c.attributionKey.equals(e.attributionKey)) return { ok: false, reason: "wrong_attribution_key" };
  if (c.price !== e.routePrice) return { ok: false, reason: "price_mismatch" }; // exact: neither cheaper nor dearer than the route
  if (c.expiry < e.nowSec + e.minLifeSecs) return { ok: false, reason: "expiring" };
  if (c.distributor.equals(c.buyer)) return { ok: false, reason: "self_referral" };
  return { ok: true, claim: c };
}
