// Hand-built instructions for the two merchant actions, so no Anchor runtime ships to the browser. Layouts mirror
// program/programs/noux/src/lib.rs; test/program.test.ts checks the discriminators against the generated IDL.
import { Buffer } from "buffer";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey((import.meta.env.VITE_PROGRAM_ID as string | undefined) ?? "AC6AtoRALLszNGNLmHte2UXKzCqBYQKhPdtq5qs77nkL");
/** Devnet USDC (Circle faucet). Override per cluster at build time. */
export const USDC_MINT = new PublicKey((import.meta.env.VITE_USDC_MINT as string | undefined) ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
export { CHAIN } from "./chain";
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export const DISC = {
  createCampaign: Uint8Array.from([111, 131, 187, 98, 160, 193, 114, 244]),
  refundSale: Uint8Array.from([65, 216, 1, 125, 151, 16, 225, 13]),
};

export const MAX_COMMISSION_BPS = 5000, MAX_HOLD_SECS = 600;
export const configPda = (programId = PROGRAM_ID) => PublicKey.findProgramAddressSync([new TextEncoder().encode("config")], programId)[0];
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
export const campaignPda = (merchant: PublicKey, id: bigint, programId = PROGRAM_ID) => {
  const b = u64(id);
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("campaign"), merchant.toBuffer(), b], programId)[0];
};
export const ata = (owner: PublicKey, mint = USDC_MINT) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

/** "50.25" -> 50250000n. Throws on anything that is not a plain non-negative decimal with <= `decimals` places. */
export function parseAmount(s: string, decimals = 6): bigint {
  const t = s.replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error("enter a plain number");
  const [i, f = ""] = t.split(".");
  if (f.length > decimals) throw new Error(`at most ${decimals} decimal places`);
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, "0") || "0");
}

export interface CreateCampaignArgs { merchant: PublicKey; campaignId: bigint; commissionBps: number; budget: bigint; attributionKey: PublicKey; cluster: string; holdSecs: number }

export function createCampaignIx(a: CreateCampaignArgs): TransactionInstruction {
  if (a.commissionBps < 0 || a.commissionBps > MAX_COMMISSION_BPS) throw new Error("commission out of range");
  if (a.holdSecs < 0 || a.holdSecs > MAX_HOLD_SECS) throw new Error("hold out of range");
  const tag = new Uint8Array(8); tag.set(new TextEncoder().encode(a.cluster).slice(0, 8));
  if (a.cluster.length === 0 || a.cluster.length > 8) throw new Error("cluster tag must be 1-8 ascii chars");
  const raw = new Uint8Array(8 + 8 + 2 + 8 + 32 + 8 + 4), dv = new DataView(raw.buffer);
  let o = 0;
  raw.set(DISC.createCampaign, o); o += 8;
  dv.setBigUint64(o, a.campaignId, true); o += 8;
  dv.setUint16(o, a.commissionBps, true); o += 2;
  dv.setBigUint64(o, a.budget, true); o += 8;
  raw.set(a.attributionKey.toBytes(), o); o += 32;
  raw.set(tag, o); o += 8;
  dv.setUint32(o, a.holdSecs, true);
  const data = Buffer.from(raw);
  return new TransactionInstruction({
    programId: PROGRAM_ID, data,
    keys: [
      { pubkey: a.merchant, isSigner: true, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: campaignPda(a.merchant, a.campaignId), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

export interface RefundArgs { merchant: PublicKey; campaign: PublicKey; sale: PublicKey; buyer: PublicKey; rentPayer: PublicKey }
export function refundSaleIx(a: RefundArgs): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID, data: Buffer.from(DISC.refundSale),
    keys: [
      { pubkey: a.merchant, isSigner: true, isWritable: false },
      { pubkey: a.campaign, isSigner: false, isWritable: true },
      { pubkey: a.sale, isSigner: false, isWritable: true },
      { pubkey: ata(a.sale), isSigner: false, isWritable: true },
      { pubkey: ata(a.buyer), isSigner: false, isWritable: true },
      { pubkey: a.rentPayer, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
  });
}

export interface Blockhash { blockhash: string; lastValidBlockHeight: number }
export const newTx = (ix: TransactionInstruction, feePayer: PublicKey, bh: Blockhash) => {
  const t = new Transaction({ feePayer, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }); t.add(ix); return t;
};

// ---- listing (merchant-signed message; mirrors packages/core/src/listing.ts) ----
export interface ListingInput { name: string; description: string; category: string; endpointUrl: string; route: string; displayPrice: string; website?: string; isSample: boolean }
export function canonicalListing(l: ListingInput): string {
  const o: Record<string, unknown> = { category: l.category, description: l.description, displayPrice: l.displayPrice, endpointUrl: l.endpointUrl, isSample: l.isSample, name: l.name, route: l.route };
  if (l.website) o.website = l.website;
  return JSON.stringify(o, Object.keys(o).sort());
}
export async function listingMessage(campaign: string, l: ListingInput, ts: number): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalListing(l)));
  const hex = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
  return new TextEncoder().encode(`NOUX-LISTING-v1|${campaign}|${hex}|${ts}`);
}
