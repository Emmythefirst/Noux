import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder } from "@anchor-lang/core";
import bs58 from "bs58";
import { idl } from "@noux/core";
import { AnchorIndexerChain } from "../src/indexer/chain";

/** Runs REAL Anchor-encoded accounts through the REAL decoder (a fake Connection only serves the bytes), so enum casing,
 *  snake_case field names and number types are exercised exactly as on devnet. (A fixture-only test once hid a status-casing bug.) */
const coder = new BorshAccountsCoder(idl as any);
const PROGRAM = new PublicKey((idl as any).address);
const pk = () => Keypair.generate().publicKey;
const bn = (n: number | bigint) => new (require("bn.js"))(n.toString());

function encodeCampaign(o: any) { return coder.encode("Campaign", o); }
const campaignObj = { merchant: pk(), mint: pk(), fee_owner: pk(), attribution_key: pk(), cluster: [...Buffer.from("devnet\0\0")], hold_secs: 15, settled_count: bn(3), refunded_count: bn(1), campaign_id: bn(42), commission_budget: bn(1_000_000), commission_spent: bn(15_000), commission_bps: 1500, fee_bps: 100, bump: 255 };
const saleObj = (status: any) => ({ campaign: pk(), distributor: pk(), buyer: pk(), rent_payer: pk(), nonce: [...Buffer.alloc(32, 7)], expiry: bn(1_800_000_600), opened_at: bn(1_800_000_000), hold_until: bn(1_800_000_015), settled_at: bn(1_800_000_100), price: bn(100_000), gross: bn(100_000), merchant_amount: bn(84_000), commission_amount: bn(15_000), fee_amount: bn(1_000), commission_bps: 1500, fee_bps: 100, status, bump: 254 });

const vaults = new Map<string, Buffer>();
async function run(accounts: { pubkey: PublicKey; data: Buffer }[]) {
  const conn: any = {
    getSlot: async () => 99,
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => (vaults.has(k.toBase58()) ? { data: vaults.get(k.toBase58())! } : null)),
    getProgramAccounts: async (_p: PublicKey, cfg: any) => {
      const want = cfg.filters[0].memcmp.bytes;
      return accounts.filter((a) => bs58.encode(a.data.subarray(0, 8)) === want).map((a) => ({ pubkey: a.pubkey, account: { data: a.data } }));
    },
  };
  return new AnchorIndexerChain(conn, PROGRAM).snapshot();
}

describe("AnchorIndexerChain with real encoded accounts", () => {
  it("decodes campaigns and maps every field", async () => {
    const addr = pk(); const snap = await run([{ pubkey: addr, data: await encodeCampaign(campaignObj) }]);
    expect(snap.slot).toBe(99); expect(snap.campaigns).toHaveLength(1);
    expect(snap.campaigns[0]).toEqual({
      address: addr.toBase58(), merchant: campaignObj.merchant.toBase58(), mint: campaignObj.mint.toBase58(), feeOwner: campaignObj.fee_owner.toBase58(),
      attributionKey: campaignObj.attribution_key.toBase58(), cluster: "devnet", holdSecs: 15, commissionBps: 1500, feeBps: 100,
      commissionBudget: "1000000", commissionSpent: "15000", settledCount: "3", refundedCount: "1",
    });
  });
  it("normalises sale status casing for ALL variants (the bug the fixtures missed)", async () => {
    const accts = await Promise.all([{ Open: {} }, { Settled: {} }, { Refunded: {} }].map(async (st) => ({ pubkey: pk(), data: await coder.encode("Sale", saleObj(st)) })));
    const snap = await run(accts);
    expect(snap.sales.map((s) => s.status).sort()).toEqual(["open", "refunded", "settled"]);
  });
  it("maps sale amounts, times and parties", async () => {
    const o = saleObj({ Settled: {} }); const addr = pk(); const snap = await run([{ pubkey: addr, data: await coder.encode("Sale", o) }]);
    expect(snap.sales[0]).toEqual({
      address: addr.toBase58(), campaign: o.campaign.toBase58(), distributor: o.distributor.toBase58(), buyer: o.buyer.toBase58(), rentPayer: o.rent_payer.toBase58(),
      price: "100000", gross: "100000", merchantAmount: "84000", commissionAmount: "15000", feeAmount: "1000", commissionBps: 1500, feeBps: 100, status: "settled",
      openedAt: 1_800_000_000, holdUntil: 1_800_000_015, expiry: 1_800_000_600, settledAt: 1_800_000_100, vaultAmount: "0",
    });
  });
  it("an open sale has settledAt = null; garbage accounts are skipped, not fatal", async () => {
    const o = { ...saleObj({ Open: {} }), settled_at: bn(0) };
    const snap = await run([{ pubkey: pk(), data: await coder.encode("Sale", o) }, { pubkey: pk(), data: Buffer.concat([Buffer.from(await coder.encode("Sale", o)).subarray(0, 8), Buffer.alloc(10)]) }]);
    expect(snap.sales).toHaveLength(1); expect(snap.sales[0].settledAt).toBeNull();
  });
  it("reads the vault balance of OPEN sales (the sale account has gross = 0 until settlement), and a missing vault is 0", async () => {
    const o = { ...saleObj({ Open: {} }), settled_at: bn(0), gross: bn(0) }; const addr = pk();
    const camp = { ...campaignObj }; const campAddr = o.campaign as PublicKey;
    const chain = new AnchorIndexerChain({} as any, PROGRAM);
    const token = Buffer.alloc(165); token.writeBigUInt64LE(10_000n, 64); // SPL token account: amount at offset 64
    vaults.clear(); vaults.set(chain.vaultOf(addr.toBase58(), camp.mint.toBase58()), token);
    const funded = await run([{ pubkey: campAddr, data: await encodeCampaign(camp) }, { pubkey: addr, data: await coder.encode("Sale", o) }]);
    expect(funded.sales[0]).toMatchObject({ status: "open", gross: "0", vaultAmount: "10000" });
    vaults.clear();
    const unpaid = await run([{ pubkey: campAddr, data: await encodeCampaign(camp) }, { pubkey: addr, data: await coder.encode("Sale", o) }]);
    expect(unpaid.sales[0].vaultAmount).toBe("0");
    const settled = await run([{ pubkey: campAddr, data: await encodeCampaign(camp) }, { pubkey: pk(), data: await coder.encode("Sale", saleObj({ Settled: {} })) }]);
    expect(settled.sales[0].vaultAmount).toBe("0"); // only open sales are looked up
  });
  it("derives the same vault address as the SPL associated-token derivation", () => {
    const sale = pk(), mint = pk();
    const expected = PublicKey.findProgramAddressSync([sale.toBuffer(), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBuffer(), mint.toBuffer()], new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"))[0].toBase58();
    expect(new AnchorIndexerChain({} as any, PROGRAM).vaultOf(sale.toBase58(), mint.toBase58())).toBe(expected);
  });
});
