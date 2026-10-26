import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";

import { CLAIM_TAG, CLAIM_REQUEST_TAG, PROGRAM_CLAIM_TAG_LEN } from "./brand";

/** Must match `claim_message` in program/programs/noux/src/lib.rs byte for byte. */
export const CLAIM_MESSAGE_LEN = 184 + PROGRAM_CLAIM_TAG_LEN;
export const CLUSTER_TAG_LEN = 8;

export interface ClaimParams {
  programId: PublicKey;
  /** Up to 8 ASCII chars, NUL padded on the wire (e.g. "devnet", "mainnet"). */
  cluster: string;
  campaign: PublicKey;
  distributor: PublicKey;
  buyer: PublicKey;
  /** Unix seconds. */
  expiry: number;
  /** Base units of the campaign mint. */
  price: bigint;
  nonce: Uint8Array;
}

export function clusterTag(cluster: string): Buffer {
  const b = Buffer.alloc(CLUSTER_TAG_LEN);
  const raw = Buffer.from(cluster, "ascii");
  if (raw.length === 0 || raw.length > CLUSTER_TAG_LEN) throw new Error(`cluster tag must be 1-${CLUSTER_TAG_LEN} ascii bytes`);
  raw.copy(b);
  return b;
}

const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64le = (n: number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };

export function buildClaimMessage(p: ClaimParams): Buffer {
  if (p.nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  if (p.price <= 0n) throw new Error("price must be > 0");
  const m = Buffer.concat([
    Buffer.from(CLAIM_TAG, "ascii"), p.programId.toBuffer(), clusterTag(p.cluster), p.campaign.toBuffer(),
    p.distributor.toBuffer(), p.buyer.toBuffer(), i64le(p.expiry), u64le(p.price), Buffer.from(p.nonce),
  ]);
  if (m.length !== CLAIM_MESSAGE_LEN) throw new Error(`claim message is ${m.length} bytes, expected ${CLAIM_MESSAGE_LEN}`);
  return m;
}

/** Anything that can produce an ed25519 signature: a local key now, a KMS/HSM later. The key never leaves it. */
export interface ClaimSigner {
  publicKey: PublicKey;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export class LocalKeySigner implements ClaimSigner {
  readonly publicKey: PublicKey;
  #secret: Uint8Array; // 64 bytes; private field so it can't be logged by accident via JSON/inspect of the object
  constructor(secretKey: Uint8Array) {
    if (secretKey.length !== 64) throw new Error("expected a 64-byte ed25519 secret key");
    this.#secret = secretKey;
    this.publicKey = new PublicKey(nacl.sign.keyPair.fromSecretKey(secretKey).publicKey);
  }
  async sign(message: Uint8Array) { return nacl.sign.detached(message, this.#secret); }
  toJSON() { return { type: "LocalKeySigner", publicKey: this.publicKey.toBase58() }; }
  [Symbol.for("nodejs.util.inspect.custom")]() { return `LocalKeySigner(${this.publicKey.toBase58()})`; }
}

export interface SignedClaim extends ClaimParams {
  attributionKey: PublicKey;
  /** The exact bytes that were signed. */
  message: Buffer;
  signature: Uint8Array;
}

export async function signClaim(signer: ClaimSigner, p: ClaimParams): Promise<SignedClaim> {
  const message = buildClaimMessage(p);
  const signature = await signer.sign(message);
  return { ...p, attributionKey: signer.publicKey, message, signature };
}

/** Off-chain pre-check (cheap): lets a gateway refuse to spend rent on a claim that would fail on-chain. */
export function verifyClaimSignature(c: Pick<SignedClaim, "attributionKey" | "message" | "signature">): boolean {
  return nacl.sign.detached.verify(c.message, c.signature, c.attributionKey.toBytes());
}

/** True if the signed message is exactly the one derived from the claim's fields (not a substituted message). */
export function claimIsSelfConsistent(c: SignedClaim): boolean {
  try { return buildClaimMessage(c).equals(c.message) && verifyClaimSignature(c); } catch { return false; }
}

/* ---- JSON wire format ---- */
export interface ClaimWire {
  programId: string; cluster: string; campaign: string; distributor: string; buyer: string;
  expiry: number; price: string; nonce: string; attributionKey: string; message: string; signature: string;
}
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
export function claimToWire(c: SignedClaim): ClaimWire {
  return {
    programId: c.programId.toBase58(), cluster: c.cluster, campaign: c.campaign.toBase58(), distributor: c.distributor.toBase58(),
    buyer: c.buyer.toBase58(), expiry: c.expiry, price: c.price.toString(), nonce: hex(c.nonce),
    attributionKey: c.attributionKey.toBase58(), message: c.message.toString("base64"), signature: Buffer.from(c.signature).toString("base64"),
  };
}
export function claimFromWire(w: ClaimWire): SignedClaim {
  return {
    programId: new PublicKey(w.programId), cluster: w.cluster, campaign: new PublicKey(w.campaign), distributor: new PublicKey(w.distributor),
    buyer: new PublicKey(w.buyer), expiry: w.expiry, price: BigInt(w.price), nonce: Buffer.from(w.nonce, "hex"),
    attributionKey: new PublicKey(w.attributionKey), message: Buffer.from(w.message, "base64"), signature: Buffer.from(w.signature, "base64"),
  };
}

/* ---- buyer-signed claim request (proves the buyer wallet consents; prevents binding claims to wallets you don't control) ---- */
export interface ClaimRequestAuth { campaign: PublicKey; distributor: PublicKey; buyer: PublicKey; price: bigint; ts: number }
export function claimRequestMessage(a: ClaimRequestAuth): Buffer {
  return Buffer.from(`${CLAIM_REQUEST_TAG}|${a.campaign.toBase58()}|${a.distributor.toBase58()}|${a.buyer.toBase58()}|${a.price}|${a.ts}`, "utf8");
}
export function signClaimRequest(buyerSecret: Uint8Array, a: ClaimRequestAuth): Uint8Array {
  return nacl.sign.detached(claimRequestMessage(a), buyerSecret);
}
export function verifyClaimRequest(a: ClaimRequestAuth, signature: Uint8Array, nowSec: number, maxSkewSec = 60): boolean {
  if (Math.abs(nowSec - a.ts) > maxSkewSec) return false;
  return nacl.sign.detached.verify(claimRequestMessage(a), signature, a.buyer.toBytes());
}
