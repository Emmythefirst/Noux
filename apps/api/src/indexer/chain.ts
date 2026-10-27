import { Connection, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder } from "@anchor-lang/core";
import bs58 from "bs58";
import { idl } from "@noux/core";

export type SaleStatus = "open" | "settled" | "refunded";
export interface CampaignRow {
  address: string; merchant: string; mint: string; feeOwner: string; attributionKey: string; cluster: string; holdSecs: number;
  commissionBps: number; feeBps: number; commissionBudget: string; commissionSpent: string; settledCount: string; refundedCount: string;
}
export interface SaleRow {
  address: string; campaign: string; distributor: string; buyer: string; rentPayer: string; price: string; gross: string;
  merchantAmount: string; commissionAmount: string; feeAmount: string; commissionBps: number; feeBps: number; status: SaleStatus;
  openedAt: number; holdUntil: number; expiry: number; settledAt: number | null;
}
export interface SigInfo { signature: string; blockTime: number | null; failed: boolean }
export interface Snapshot { slot: number; campaigns: CampaignRow[]; sales: SaleRow[] }
export interface IndexerChain {
  snapshot(): Promise<Snapshot>;
  /** Newest first. */
  signatures(address: string, limit?: number): Promise<SigInfo[]>;
  /** Associated token account of `owner` for the campaign mint (the per-sale vault). */
  vaultOf(salePda: string, mint: string): string;
}

const coder = new BorshAccountsCoder(idl as any);
const disc = (name: string) => Buffer.from((idl as any).accounts.find((a: any) => a.name === name).discriminator);
const s = (x: any) => (x === null || x === undefined ? "0" : x.toString());
const f = (o: any, a: string, b: string) => o[a] ?? o[b];

export class AnchorIndexerChain implements IndexerChain {
  constructor(private conn: Connection, private programId: PublicKey) {}

  async snapshot(): Promise<Snapshot> {
    const slot = await this.conn.getSlot("confirmed");
    const [cRaw, sRaw] = await Promise.all(["Campaign", "Sale"].map((n) =>
      this.conn.getProgramAccounts(this.programId, { commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc(n)) } }] })));
    const campaigns: CampaignRow[] = [];
    for (const { pubkey, account } of cRaw) {
      let c: any; try { c = coder.decode("Campaign", account.data); } catch { continue; } // older layouts are skipped, not fatal
      campaigns.push({
        address: pubkey.toBase58(), merchant: c.merchant.toBase58(), mint: c.mint.toBase58(), feeOwner: f(c, "fee_owner", "feeOwner").toBase58(),
        attributionKey: f(c, "attribution_key", "attributionKey").toBase58(), cluster: Buffer.from(c.cluster).toString("ascii").replace(/\0+$/, ""),
        holdSecs: Number(f(c, "hold_secs", "holdSecs")), commissionBps: Number(f(c, "commission_bps", "commissionBps")), feeBps: Number(f(c, "fee_bps", "feeBps")),
        commissionBudget: s(f(c, "commission_budget", "commissionBudget")), commissionSpent: s(f(c, "commission_spent", "commissionSpent")),
        settledCount: s(f(c, "settled_count", "settledCount")), refundedCount: s(f(c, "refunded_count", "refundedCount")),
      });
    }
    const sales: SaleRow[] = [];
    for (const { pubkey, account } of sRaw) {
      let x: any; try { x = coder.decode("Sale", account.data); } catch { continue; }
      // Anchor's raw decoder keeps the IDL's PascalCase variant names ("Settled"); the high-level client camelCases them. Normalise.
      const status = Object.keys(x.status)[0].toLowerCase() as SaleStatus;
      if (!["open", "settled", "refunded"].includes(status)) continue; // unknown future variant: skip, don't store garbage
      const settledAt = Number(s(f(x, "settled_at", "settledAt")));
      sales.push({
        address: pubkey.toBase58(), campaign: x.campaign.toBase58(), distributor: x.distributor.toBase58(), buyer: x.buyer.toBase58(), rentPayer: f(x, "rent_payer", "rentPayer").toBase58(),
        price: s(x.price), gross: s(x.gross), merchantAmount: s(f(x, "merchant_amount", "merchantAmount")), commissionAmount: s(f(x, "commission_amount", "commissionAmount")), feeAmount: s(f(x, "fee_amount", "feeAmount")),
        commissionBps: Number(f(x, "commission_bps", "commissionBps")), feeBps: Number(f(x, "fee_bps", "feeBps")), status,
        openedAt: Number(s(f(x, "opened_at", "openedAt"))), holdUntil: Number(s(f(x, "hold_until", "holdUntil"))), expiry: Number(s(x.expiry)), settledAt: settledAt > 0 ? settledAt : null,
      });
    }
    return { slot, campaigns, sales };
  }

  async signatures(address: string, limit = 20): Promise<SigInfo[]> {
    const r = await this.conn.getSignaturesForAddress(new PublicKey(address), { limit }, "confirmed");
    return r.map((x) => ({ signature: x.signature, blockTime: x.blockTime ?? null, failed: !!x.err }));
  }

  vaultOf(salePda: string, mint: string): string {
    // ATA address derivation (owner may be a PDA): [owner, token program, mint] under the ATA program
    const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    return PublicKey.findProgramAddressSync([new PublicKey(salePda).toBuffer(), TOKEN.toBuffer(), new PublicKey(mint).toBuffer()], ATA)[0].toBase58();
  }
}
