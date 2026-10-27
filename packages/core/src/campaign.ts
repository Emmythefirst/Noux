import { Connection, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder } from "@anchor-lang/core";
import { idl } from "./idl";
import { configPda } from "./pda";

export interface CampaignInfo {
  address: PublicKey; merchant: PublicKey; mint: PublicKey; feeOwner: PublicKey; attributionKey: PublicKey;
  cluster: string; holdSecs: number; commissionBps: number; feeBps: number;
  commissionBudget: bigint; commissionSpent: bigint; settledCount: bigint; refundedCount: bigint;
}
/** The global protocol config: fee % and fee wallet for NEW campaigns, and the key allowed to change them. */
export interface ProtocolConfig { admin: PublicKey; feeOwner: PublicKey; feeBps: number }
export interface CampaignReader { get(address: PublicKey): Promise<CampaignInfo | null>; config?(): Promise<ProtocolConfig | null>; }

const coder = new BorshAccountsCoder(idl as any);

export class OnchainCampaignReader implements CampaignReader {
  constructor(private conn: Connection, private programId: PublicKey, private ttlMs = 15_000, private negTtlMs = 5_000) {}
  #cache = new Map<string, { at: number; v: CampaignInfo | null }>();
  #cfg: { at: number; v: ProtocolConfig | null } | null = null;
  async config(): Promise<ProtocolConfig | null> {
    if (this.#cfg && Date.now() - this.#cfg.at < 30_000) return this.#cfg.v;
    const info = await this.conn.getAccountInfo(configPda(this.programId), "confirmed");
    let v: ProtocolConfig | null = null;
    if (info && info.owner.equals(this.programId)) {
      try { const c: any = coder.decode("Config", info.data); v = { admin: c.admin, feeOwner: c.fee_owner ?? c.feeOwner, feeBps: Number(c.fee_bps ?? c.feeBps) }; } catch { v = null; }
    }
    this.#cfg = { at: Date.now(), v };
    return v;
  }
  async get(address: PublicKey): Promise<CampaignInfo | null> {
    const k = address.toBase58(), hit = this.#cache.get(k);
    if (hit && Date.now() - hit.at < (hit.v ? this.ttlMs : this.negTtlMs)) return hit.v;
    const info = await this.conn.getAccountInfo(address, "confirmed");
    let v: CampaignInfo | null = null;
    // Must be owned by OUR program and decode as a Campaign; anything else is "not a campaign".
    if (info && info.owner.equals(this.programId)) {
      try {
        const c: any = coder.decode("Campaign", info.data);
        v = {
          address, merchant: c.merchant, mint: c.mint, feeOwner: c.fee_owner ?? c.feeOwner, attributionKey: c.attribution_key ?? c.attributionKey,
          cluster: Buffer.from(c.cluster).toString("ascii").replace(/\0+$/, ""), holdSecs: Number(c.hold_secs ?? c.holdSecs),
          commissionBps: Number(c.commission_bps ?? c.commissionBps), feeBps: Number(c.fee_bps ?? c.feeBps),
          commissionBudget: BigInt((c.commission_budget ?? c.commissionBudget).toString()), commissionSpent: BigInt((c.commission_spent ?? c.commissionSpent).toString()),
          settledCount: BigInt((c.settled_count ?? c.settledCount).toString()), refundedCount: BigInt((c.refunded_count ?? c.refundedCount).toString()),
        };
      } catch { v = null; }
    }
    this.#cache.set(k, { at: Date.now(), v });
    return v;
  }
}
