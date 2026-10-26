// Settlement sweeper (keeper). Idempotent: settles any Open sale whose hold has elapsed and whose vault holds >= price.
// Safe to run repeatedly / concurrently: settle_sale is permissionless and a settled sale's vault is closed,
// so a second attempt just fails and is skipped.
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";

export async function sweep({ program, conn, payer, mint, only = null, log = () => {} }) {
  const out = { settled: [], skipped: 0, failed: [] };
  const campaigns = new Map();
  // Fetch only accounts of the current Sale size and decode defensively: Sale accounts created by an older
  // program layout must be skipped, not crash the keeper.
  const raw = await conn.getProgramAccounts(program.programId, { filters: [{ dataSize: program.account.sale.size }] });
  const sales = [];
  for (const { pubkey, account } of raw) {
    try { sales.push({ publicKey: pubkey, account: program.coder.accounts.decode("sale", account.data) }); } catch { out.skipped++; }
  }
  for (const { publicKey: salePk, account: s } of sales) {
    if (only && !only.some((k) => k.equals(salePk))) { out.skipped++; continue; }
    if (!("open" in s.status)) { out.skipped++; continue; }
    if (Date.now() / 1000 < s.holdUntil.toNumber()) { out.skipped++; continue; } // still in the refund hold; merchant may settle early
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
        caller: payer.publicKey, campaign: s.campaign, sale: salePk, saleVault: vault, merchantAta: ata(c.merchant), distributorAta: ata(s.distributor),
        feeAta: ata(c.feeOwner), rentPayer: s.rentPayer, tokenProgram: TOKEN_PROGRAM_ID,
      }).preInstructions(pre).rpc();
      out.settled.push({ sale: salePk.toBase58(), sig }); log(`swept ${salePk.toBase58()}`);
    } catch (e) { out.failed.push({ sale: salePk.toBase58(), err: e.message?.slice(0, 160) }); }
  }
  return out;
}
