import crypto from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { LISTING_TAG } from "./brand";

export const LISTING_CATEGORIES = ["ai-text", "research-search", "data-feeds", "developer-tools", "other"] as const;
export type ListingCategory = (typeof LISTING_CATEGORIES)[number];

/** Off-chain, merchant-authored description of a campaign's service. Shown in the public directory. */
export interface Listing {
  name: string; description: string; category: ListingCategory;
  /** Public https URL of the paid endpoint (the merchant gateway). */
  endpointUrl: string; /** e.g. "GET /report" */ route: string; /** human-readable, e.g. "$0.10" */ displayPrice: string;
  website?: string;
  /** TRUE for services built by the Noux team for demos. Surfaced prominently in every UI. */
  isSample: boolean;
}

/** Deterministic JSON (sorted keys) so merchant and server hash identical bytes. */
export function canonicalListing(l: Listing): string {
  const o: Record<string, unknown> = { category: l.category, description: l.description, displayPrice: l.displayPrice, endpointUrl: l.endpointUrl, isSample: l.isSample, name: l.name, route: l.route };
  if (l.website) o.website = l.website;
  return JSON.stringify(o, Object.keys(o).sort());
}
export const listingHash = (l: Listing) => crypto.createHash("sha256").update(canonicalListing(l)).digest("hex");

export interface ListingAuth { campaign: PublicKey; listing: Listing; ts: number }
export const listingMessage = (a: ListingAuth) => Buffer.from(`${LISTING_TAG}|${a.campaign.toBase58()}|${listingHash(a.listing)}|${a.ts}`, "utf8");
export const signListing = (merchantSecret: Uint8Array, a: ListingAuth) => nacl.sign.detached(listingMessage(a), merchantSecret);
/** `merchant` is read from the campaign ON-CHAIN by the verifier, never taken from the request. */
export function verifyListing(a: ListingAuth, signature: Uint8Array, merchant: PublicKey, nowSec: number, maxSkewSec = 60): boolean {
  if (Math.abs(nowSec - a.ts) > maxSkewSec) return false;
  return nacl.sign.detached.verify(listingMessage(a), signature, merchant.toBytes());
}
