import { Connection, Ed25519Program, Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { idl, salePda, type SignedClaim } from "@axia/core";
import type { LandedCheck } from "./resilient-facilitator";

/** Everything the middleware needs from the chain, behind interfaces so it can be tested without one. */
export interface SaleOpener {
  /** Idempotent: opens the per-sale deposit account for a verified claim if it doesn't exist yet. */
  ensureOpen(claim: SignedClaim): Promise<PublicKey>;
}
export interface SaleSettler {
  /** Merchant-signed: settle right after delivery, skipping the hold. */
  settle(claim: SignedClaim): Promise<string | null>;
  /** Merchant-signed: send the vault back to the claim's buyer; no commission. */
  refund(claim: SignedClaim): Promise<string>;
}

export class AnchorChain implements SaleOpener, SaleSettler {
  private program: anchor.Program;
  private inflight = new Map<string, Promise<PublicKey>>();
  constructor(private o: { connection: Connection; programId: PublicKey; mint: PublicKey; gatewayPayer: Keypair; merchant?: Keypair; log?: (m: string, d?: unknown) => void }) {
    const provider = new anchor.AnchorProvider(o.connection, new anchor.Wallet(o.gatewayPayer), { commitment: "confirmed" });
    this.program = new anchor.Program(idl as anchor.Idl, provider);
  }
  private ata = (owner: PublicKey) => getAssociatedTokenAddressSync(this.o.mint, owner, true);

  ensureOpen(c: SignedClaim): Promise<PublicKey> {
    const sale = salePda(this.o.programId, c.campaign, c.nonce);
    const k = sale.toBase58();
    // Concurrent requests carrying the same claim (unpaid + paid, retries) share ONE open transaction.
    const existing = this.inflight.get(k); if (existing) return existing;
    const p = (async () => {
      if (await this.o.connection.getAccountInfo(sale, "confirmed")) return sale;
      await this.program.methods.openSale([...c.nonce], new anchor.BN(c.expiry), new anchor.BN(c.price.toString()))
        .accounts({
          payer: this.o.gatewayPayer.publicKey, campaign: c.campaign, distributor: c.distributor, buyer: c.buyer, mint: this.o.mint, sale,
          saleVault: this.ata(sale), instructions: SYSVAR_INSTRUCTIONS_PUBKEY, tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        })
        .preInstructions([Ed25519Program.createInstructionWithPublicKey({ publicKey: c.attributionKey.toBytes(), message: c.message, signature: c.signature })])
        .rpc();
      return sale;
    })().finally(() => setTimeout(() => this.inflight.delete(k), 5_000));
    this.inflight.set(k, p);
    return p;
  }

  private merchantKey(): Keypair { if (!this.o.merchant) throw new Error("merchant signer not configured"); return this.o.merchant; }

  async settle(c: SignedClaim): Promise<string | null> {
    const m = this.merchantKey(); const sale = salePda(this.o.programId, c.campaign, c.nonce);
    const camp: any = await (this.program.account as any).campaign.fetch(c.campaign);
    const pre = [m.publicKey, c.distributor, camp.feeOwner].map((o: PublicKey) => createAssociatedTokenAccountIdempotentInstruction(this.o.gatewayPayer.publicKey, this.ata(o), o, this.o.mint));
    return this.program.methods.settleSale().accounts({
      caller: m.publicKey, campaign: c.campaign, sale, saleVault: this.ata(sale), merchantAta: this.ata(camp.merchant), distributorAta: this.ata(c.distributor),
      feeAta: this.ata(camp.feeOwner), rentPayer: this.o.gatewayPayer.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
    }).preInstructions(pre).signers([m]).rpc();
  }

  async refund(c: SignedClaim): Promise<string> {
    const m = this.merchantKey(); const sale = salePda(this.o.programId, c.campaign, c.nonce);
    return this.program.methods.refundSale().accounts({
      merchant: m.publicKey, campaign: c.campaign, sale, saleVault: this.ata(sale), buyerAta: this.ata(c.buyer),
      rentPayer: this.o.gatewayPayer.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
    }).preInstructions([createAssociatedTokenAccountIdempotentInstruction(this.o.gatewayPayer.publicKey, this.ata(c.buyer), c.buyer, this.o.mint)]).signers([m]).rpc();
  }
}

/**
 * "Did this payment already land?" for a per-sale vault: the vault holds >= the required amount. Reads only.
 * For any other payTo (the merchant's own wallet, whose balance mixes unrelated funds) we answer "unknown" on purpose.
 */
export function vaultFundedCheck(conn: Connection, mint: PublicKey, isSale: (payTo: string) => boolean) {
  return async (_payload: unknown, req: { payTo: string; amount: string }): Promise<LandedCheck> => {
    if (!isSale(req.payTo)) return { landed: "unknown" };
    const vault = getAssociatedTokenAddressSync(mint, new PublicKey(req.payTo), true);
    let bal: bigint;
    try { bal = BigInt((await conn.getTokenAccountBalance(vault, "confirmed")).value.amount); }
    catch (e) { if (/could not find account|Invalid param/i.test(String((e as Error).message))) return { landed: false }; throw e; }
    if (bal < BigInt(req.amount)) return { landed: false };
    const sigs = await conn.getSignaturesForAddress(vault, { limit: 1 }, "confirmed");
    return { landed: true, transaction: sigs[0]?.signature };
  };
}

/* ---------------- keeper adapter ---------------- */
import type { KeeperChain, OpenSale } from "./keeper";

export class AnchorKeeperChain implements KeeperChain {
  private program: anchor.Program;
  private campaigns = new Map<string, any>();
  constructor(private o: { connection: Connection; programId: PublicKey; mint: PublicKey; payer: Keypair }) {
    this.program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(o.connection, new anchor.Wallet(o.payer), { commitment: "confirmed" }));
  }
  private ata = (owner: PublicKey) => getAssociatedTokenAddressSync(this.o.mint, owner, true);
  private async campaign(pk: PublicKey) {
    const k = pk.toBase58(); let c = this.campaigns.get(k);
    if (!c) { c = await (this.program.account as any).campaign.fetch(pk); this.campaigns.set(k, c); }
    return c;
  }

  async listOpenSales(): Promise<OpenSale[]> {
    const size = (this.program.account as any).sale.size as number;
    const raw = await this.o.connection.getProgramAccounts(this.o.programId, { filters: [{ dataSize: size }], commitment: "confirmed" });
    const out: OpenSale[] = [];
    for (const { pubkey, account } of raw) {
      let s: any; try { s = this.program.coder.accounts.decode("sale", account.data); } catch { continue; } // legacy layouts are skipped, not fatal
      if (!("open" in s.status)) continue;
      out.push({ sale: pubkey.toBase58(), price: BigInt(s.price.toString()), holdSecs: Math.max(0, s.holdUntil.toNumber() - s.openedAt.toNumber()), holdUntil: s.holdUntil.toNumber(), expiry: s.expiry.toNumber() });
    }
    return out;
  }

  async vaultBalance(sale: string): Promise<bigint | null> {
    try { return BigInt((await this.o.connection.getTokenAccountBalance(this.ata(new PublicKey(sale)), "confirmed")).value.amount); }
    catch (e) { if (/could not find account|Invalid param/i.test(String((e as Error).message))) return null; throw e; }
  }

  async settle(sale: string): Promise<string> {
    const salePk = new PublicKey(sale); const s: any = await (this.program.account as any).sale.fetch(salePk); const c = await this.campaign(s.campaign);
    const pre = [c.merchant, s.distributor, c.feeOwner].map((o: PublicKey) => createAssociatedTokenAccountIdempotentInstruction(this.o.payer.publicKey, this.ata(o), o, this.o.mint));
    return this.program.methods.settleSale().accounts({
      caller: this.o.payer.publicKey, campaign: s.campaign, sale: salePk, saleVault: this.ata(salePk), merchantAta: this.ata(c.merchant),
      distributorAta: this.ata(s.distributor), feeAta: this.ata(c.feeOwner), rentPayer: s.rentPayer, tokenProgram: TOKEN_PROGRAM_ID,
    }).preInstructions(pre).rpc();
  }

  async closeExpired(sale: string): Promise<string> {
    const salePk = new PublicKey(sale); const s: any = await (this.program.account as any).sale.fetch(salePk);
    return this.program.methods.closeExpiredSale().accounts({
      sale: salePk, saleVault: this.ata(salePk), mint: this.o.mint, campaign: s.campaign, rentPayer: s.rentPayer, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc();
  }
}
