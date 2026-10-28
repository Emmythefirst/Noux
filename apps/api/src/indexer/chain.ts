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
  /** Token balance of the per-sale vault, for OPEN sales ("0" otherwise). The Sale account only records `gross` at settlement, so this is the only way to tell a funded sale from an unpaid one. */
  vaultAmount: string;
}
export interface SigInfo { signature: string; blockTime: number | null; failed: boolean }
export interface Snapshot { slot: number; campaigns: CampaignRow[]; sales: SaleRow[] }
/** A successful program transaction and every account key it carried (static + loaded from lookup tables). */
export interface TxKeys { signature: string; blockTime: number | null; keys: string[] }
/** What the indexer needs to follow the chain by DELTAS instead of downloading every account each pass. Optional: without it the indexer does full snapshots. */
export interface IncrementalChain {
  slot(): Promise<number>;
  /** Newest successful program transaction signature (null if none). */
  head(): Promise<string | null>;
  /** Successful program transactions newer than `cursor`, oldest first; `overflow` when there are too many to follow (caller falls back to a full snapshot). */
  txsSince(cursor: string): Promise<{ txs: TxKeys[]; overflow: boolean }>;
  campaigns(): Promise<CampaignRow[]>;
  /** Fetch and decode the Sale accounts among `addresses` (other accounts are ignored); `missing` = accounts that do not exist (closed). */
  sales(addresses: string[], mintOf: Map<string, string>): Promise<{ sales: SaleRow[]; missing: string[] }>;
}
export interface IndexerChain {
  incremental?: IncrementalChain;
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


/** Older layouts are skipped (null), not fatal. */
export function decodeCampaign(address: string, data: Buffer): CampaignRow | null {
  let c: any; try { c = coder.decode("Campaign", data); } catch { return null; }
  return {
    address, merchant: c.merchant.toBase58(), mint: c.mint.toBase58(), feeOwner: f(c, "fee_owner", "feeOwner").toBase58(),
    attributionKey: f(c, "attribution_key", "attributionKey").toBase58(), cluster: Buffer.from(c.cluster).toString("ascii").replace(/\0+$/, ""),
    holdSecs: Number(f(c, "hold_secs", "holdSecs")), commissionBps: Number(f(c, "commission_bps", "commissionBps")), feeBps: Number(f(c, "fee_bps", "feeBps")),
    commissionBudget: s(f(c, "commission_budget", "commissionBudget")), commissionSpent: s(f(c, "commission_spent", "commissionSpent")),
    settledCount: s(f(c, "settled_count", "settledCount")), refundedCount: s(f(c, "refunded_count", "refundedCount")),
  };
}

export function decodeSale(address: string, data: Buffer): SaleRow | null {
  let x: any; try { x = coder.decode("Sale", data); } catch { return null; }
  // Anchor's raw decoder keeps the IDL's PascalCase variant names ("Settled"); the high-level client camelCases them. Normalise.
  const status = Object.keys(x.status)[0].toLowerCase() as SaleStatus;
  if (!["open", "settled", "refunded"].includes(status)) return null; // unknown future variant: skip, don't store garbage
  const settledAt = Number(s(f(x, "settled_at", "settledAt")));
  return {
    address, campaign: x.campaign.toBase58(), distributor: x.distributor.toBase58(), buyer: x.buyer.toBase58(), rentPayer: f(x, "rent_payer", "rentPayer").toBase58(),
    price: s(x.price), gross: s(x.gross), merchantAmount: s(f(x, "merchant_amount", "merchantAmount")), commissionAmount: s(f(x, "commission_amount", "commissionAmount")), feeAmount: s(f(x, "fee_amount", "feeAmount")),
    commissionBps: Number(f(x, "commission_bps", "commissionBps")), feeBps: Number(f(x, "fee_bps", "feeBps")), status,
    openedAt: Number(s(f(x, "opened_at", "openedAt"))), holdUntil: Number(s(f(x, "hold_until", "holdUntil"))), expiry: Number(s(x.expiry)), settledAt: settledAt > 0 ? settledAt : null, vaultAmount: "0",
  };
}

const MAX_FOLLOW_TXS = 3000;

export class AnchorIndexerChain implements IndexerChain {
  constructor(private conn: Connection, private programId: PublicKey) {}

  async snapshot(): Promise<Snapshot> {
    const slot = await this.conn.getSlot("confirmed");
    const [cRaw, sRaw] = await Promise.all(["Campaign", "Sale"].map((n) =>
      this.conn.getProgramAccounts(this.programId, { commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc(n)) } }] })));
    const campaigns: CampaignRow[] = [];
    for (const { pubkey, account } of cRaw) { const c = decodeCampaign(pubkey.toBase58(), account.data); if (c) campaigns.push(c); }
    const sales: SaleRow[] = [];
    for (const { pubkey, account } of sRaw) { const x = decodeSale(pubkey.toBase58(), account.data); if (x) sales.push(x); }
    await this.fillVaultAmounts(sales, new Map(campaigns.map((c) => [c.address, c.mint])));
    return { slot, campaigns, sales };
  }

  private async fillVaultAmounts(sales: SaleRow[], mintOf: Map<string, string>) {
    const open = sales.filter((x) => x.status === "open" && mintOf.has(x.campaign));
    for (let i = 0; i < open.length; i += 100) {
      const chunk = open.slice(i, i + 100);
      const infos = await this.conn.getMultipleAccountsInfo(chunk.map((x) => new PublicKey(this.vaultOf(x.address, mintOf.get(x.campaign)!))), "confirmed");
      chunk.forEach((x, k) => { const d = infos[k]?.data; x.vaultAmount = d && d.length >= 72 ? d.readBigUInt64LE(64).toString() : "0"; }); // SPL token account: amount is the u64 at offset 64
    }
  }

  /** Follow the chain by deltas: new program transactions -> the accounts they carried -> only the Sale accounts among them. */
  incremental: IncrementalChain = {
    slot: () => this.conn.getSlot("confirmed"),
    head: async () => {
      const r = await this.conn.getSignaturesForAddress(this.programId, { limit: 10 }, "confirmed");
      return r.find((x) => !x.err)?.signature ?? null;
    },
    txsSince: async (cursor) => {
      const sigs: { signature: string; blockTime: number | null | undefined }[] = [];
      let before: string | undefined;
      for (;;) { // newest first, 1000 per page, stops at the cursor
        const page = await this.conn.getSignaturesForAddress(this.programId, { until: cursor, before, limit: 1000 }, "confirmed");
        for (const x of page) if (!x.err) sigs.push({ signature: x.signature, blockTime: x.blockTime });
        if (page.length < 1000) break;
        before = page[page.length - 1].signature;
        if (sigs.length > MAX_FOLLOW_TXS) return { txs: [], overflow: true };
      }
      sigs.reverse(); // oldest first
      const txs: TxKeys[] = [];
      for (let i = 0; i < sigs.length; i += 50) {
        const chunk = sigs.slice(i, i + 50);
        const res = await this.conn.getTransactions(chunk.map((x) => x.signature), { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        res.forEach((t, k) => {
          if (!t || t.meta?.err) { if (!t) throw new Error("transaction not available yet: " + chunk[k].signature); return; } // a missing body must not be skipped silently
          const keys = t.transaction.message.getAccountKeys({ accountKeysFromLookups: t.meta?.loadedAddresses }).keySegments().flat().map((p) => p.toBase58());
          txs.push({ signature: chunk[k].signature, blockTime: chunk[k].blockTime ?? null, keys });
        });
      }
      return { txs, overflow: false };
    },
    campaigns: async () => {
      const raw = await this.conn.getProgramAccounts(this.programId, { commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc("Campaign")) } }] });
      return raw.flatMap(({ pubkey, account }) => { const c = decodeCampaign(pubkey.toBase58(), account.data); return c ? [c] : []; });
    },
    sales: async (addresses, mintOf) => {
      const sales: SaleRow[] = [], missing: string[] = [], saleDisc = disc("Sale");
      for (let i = 0; i < addresses.length; i += 100) {
        const chunk = addresses.slice(i, i + 100);
        const infos = await this.conn.getMultipleAccountsInfo(chunk.map((a) => new PublicKey(a)), "confirmed");
        chunk.forEach((a, k) => {
          const info = infos[k];
          if (!info) { missing.push(a); return; }
          if (!info.owner.equals(this.programId) || info.data.length < 8 || !info.data.subarray(0, 8).equals(saleDisc)) return; // not a Sale account (a mint, a wallet, a Campaign ...)
          const x = decodeSale(a, info.data); if (x) sales.push(x);
        });
      }
      await this.fillVaultAmounts(sales, mintOf);
      return { sales, missing };
    },
  };

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
