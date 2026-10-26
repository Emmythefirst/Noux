// Settlement sweeper (keeper). Idempotent: settles any Open sale whose vault holds >= price.
// Safe to run repeatedly / concurrently: settle_sale is permissionless and a settled sale's vault is closed,
// so a second attempt just fails and is skipped.
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";

export async function sweep({ program, conn, payer, mint, log = () => {} }) {
  const out = { settled: [], skipped: 0, failed: [] };
  const campaigns = new Map();
  const sales = await program.account.sale.all();
  for (const { publicKey: salePk, account: s } of sales) {
    if (!("open" in s.status)) { out.skipped++; continue; }
    const vault = getAssociatedTokenAddressSync(mint, salePk, true);
    let amount = 0n;
    try { amount = BigInt((await conn.getTokenAccountBalance(vault)).value.amount); } catch { out.skipped++; continue; }
    if (amount < BigInt(s.price.toString())) { out.skipped++; continue; }
    try {
      if (!campaigns.has(s.campaign.toBase58())) campaigns.set(s.campaign.toBase58(), await program.account.campaign.fetch(s.campaign));
      const c = campaigns.get(s.campaign.toBase58());
      const ata = (o) => getAssociatedTokenAddressSync(mint, o, true);
      const pre = [c.merchant, s.distributor, c.feeOwner].map((o) => createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(o), o, mint));
      const sig = await program.methods.settleSale().accounts({
        campaign: s.campaign, sale: salePk, saleVault: vault, merchantAta: ata(c.merchant), distributorAta: ata(s.distributor),
        feeAta: ata(c.feeOwner), rentPayer: s.rentPayer, tokenProgram: TOKEN_PROGRAM_ID,
      }).preInstructions(pre).rpc();
      out.settled.push({ sale: salePk.toBase58(), sig }); log(`swept ${salePk.toBase58()}`);
    } catch (e) { out.failed.push({ sale: salePk.toBase58(), err: e.message?.slice(0, 160) }); }
  }
  return out;
}
