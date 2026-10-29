import crypto from "node:crypto";
import type pg from "pg";
import { PublicKey } from "@solana/web3.js";
import {
  signClaim, claimToWire, verifyClaimRequest, type CampaignReader, type ClaimSigner, type ClaimWire,
} from "@noux/core";
import type { Config } from "./config";

export class IssuanceError extends Error {
  constructor(public status: 400 | 401 | 404 | 409 | 429 | 503, public code: string, message: string, public retryAfterSec?: number) { super(message); }
}

export interface ClaimRequest {
  campaign: string; distributor: string; buyer: string; price: string; ts: number; buyerSignature: string; // base64
}
export interface Deps {
  cfg: Pick<Config, "CLUSTER" | "PROGRAM_ID" | "CLAIM_TTL_SECS" | "MAX_PRICE_BASE_UNITS" | "LIMIT_PER_DISTRIBUTOR_PER_MIN" | "LIMIT_PER_BUYER_PER_MIN" | "LIMIT_PER_CAMPAIGN_PER_MIN" | "LIMIT_PER_IP_PER_MIN">;
  pool: pg.Pool; signer: ClaimSigner; campaigns: CampaignReader; now?: () => number; // unix seconds
}

const pk = (s: string, field: string) => { try { return new PublicKey(s); } catch { throw new IssuanceError(400, "bad_request", `${field} is not a valid public key`); } };

/**
 * Issues a signed, buyer-bound claim. Order matters (cheap and unauthenticated first, expensive last):
 *  1. parse + buyer signature (proves the buyer wallet consents; also stops replay of old requests via timestamp skew)
 *  2. self-referral / price sanity
 *  3. campaign must exist on-chain, be OURS (attribution key + cluster match) - cached
 *  4. atomic rate limits (distributor / buyer / campaign / ip) + insert, under one advisory lock
 *  5. sign
 */
export async function issueClaim(d: Deps, req: ClaimRequest, ip: string): Promise<ClaimWire> {
  const now = (d.now ?? (() => Math.floor(Date.now() / 1000)))();
  const campaign = pk(req.campaign, "campaign"), distributor = pk(req.distributor, "distributor"), buyer = pk(req.buyer, "buyer");
  let price: bigint;
  try { price = BigInt(req.price); } catch { throw new IssuanceError(400, "bad_request", "price must be an integer string"); }
  if (price <= 0n || price > d.cfg.MAX_PRICE_BASE_UNITS) throw new IssuanceError(400, "bad_price", "price out of allowed range");
  if (!Number.isInteger(req.ts)) throw new IssuanceError(400, "bad_request", "ts must be an integer");

  let sig: Buffer;
  try { sig = Buffer.from(req.buyerSignature, "base64"); } catch { sig = Buffer.alloc(0); }
  if (sig.length !== 64 || !verifyClaimRequest({ campaign, distributor, buyer, price, ts: req.ts }, sig, now))
    throw new IssuanceError(401, "bad_buyer_signature", "request must be signed by the buyer wallet and be fresh (60s)");

  if (distributor.equals(buyer)) throw new IssuanceError(400, "self_referral", "distributor cannot be the buyer");

  const info = await d.campaigns.get(campaign);
  if (!info) throw new IssuanceError(404, "campaign_not_found", "no such campaign");
  if (!info.attributionKey.equals(d.signer.publicKey)) throw new IssuanceError(404, "campaign_not_found", "campaign does not use this attribution service");
  if (info.cluster !== d.cfg.CLUSTER) throw new IssuanceError(404, "campaign_not_found", "campaign is on a different cluster");
  // the program refuses new sales on a paused or ended campaign, so a claim for it would be dead on arrival: say so instead of issuing it
  if (info.state !== "active") throw new IssuanceError(409, "campaign_not_active", info.state === "paused" ? "this campaign is paused: it takes no new referral sales right now" : "this campaign has ended and takes no new referral sales");

  const nonce = crypto.randomBytes(32); // server-chosen: clients cannot grind or reuse nonces
  const expiry = now + d.cfg.CLAIM_TTL_SECS;
  const c = await d.pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext('noux-claim-issuance'))");
    const { rows } = await c.query(
      `SELECT count(*) FILTER (WHERE distributor = $1)::int AS d, count(*) FILTER (WHERE buyer = $2)::int AS b,
              count(*) FILTER (WHERE ip = $3)::int AS i, count(*) FILTER (WHERE campaign = $4)::int AS c
         FROM claim_issuance WHERE created_at > now() - interval '1 minute'`,
      [distributor.toBase58(), buyer.toBase58(), ip, campaign.toBase58()],
    );
    const r = rows[0];
    const over =
      r.d >= d.cfg.LIMIT_PER_DISTRIBUTOR_PER_MIN ? "distributor" : r.b >= d.cfg.LIMIT_PER_BUYER_PER_MIN ? "buyer" :
      r.c >= d.cfg.LIMIT_PER_CAMPAIGN_PER_MIN ? "campaign" : r.i >= d.cfg.LIMIT_PER_IP_PER_MIN ? "ip" : null;
    if (over) { await c.query("ROLLBACK"); throw new IssuanceError(429, "rate_limited", `rate limit exceeded (${over})`, 30); }
    await c.query(
      `INSERT INTO claim_issuance (campaign, distributor, buyer, ip, price, nonce, expiry) VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7))`,
      [campaign.toBase58(), distributor.toBase58(), buyer.toBase58(), ip, price.toString(), nonce.toString("hex"), expiry],
    );
    await c.query("COMMIT");
  } catch (e) {
    if (!(e instanceof IssuanceError)) { try { await c.query("ROLLBACK"); } catch { /* already rolled back */ } }
    throw e;
  } finally { c.release(); }

  const signed = await signClaim(d.signer, {
    programId: new PublicKey(d.cfg.PROGRAM_ID), cluster: d.cfg.CLUSTER, campaign, distributor, buyer, expiry, price, nonce,
  });
  return claimToWire(signed);
}
