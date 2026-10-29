import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { BorshInstructionCoder } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { DISC, USDC_MINT, ata, campaignPda, canonicalListing, configPda, createCampaignIx, listingMessage, parseAmount, refundSaleIx, setAttributionKeyIx, topUpBudgetIx, PROGRAM_ID } from "../src/lib/program";

const idl = JSON.parse(fs.readFileSync(new URL("../../../packages/core/idl/noux.json", import.meta.url), "utf8"));
const coder = new BorshInstructionCoder(idl);
const k = () => Keypair.generate().publicKey;

describe("instruction builders agree with the generated IDL", () => {
  it("discriminators are the IDL's", () => {
    for (const [name, key] of [["create_campaign", "createCampaign"], ["refund_sale", "refundSale"], ["top_up_budget", "topUpBudget"], ["set_attribution_key", "setAttributionKey"]] as const)
      expect(Array.from(DISC[key])).toEqual(idl.instructions.find((i: any) => i.name === name).discriminator);
  });
  it("create_campaign data is byte-identical to Anchor's encoding, and accounts follow the IDL order", () => {
    const a = { merchant: k(), campaignId: 123456789012n, commissionBps: 1500, budget: 50_000_000n, attributionKey: k(), cluster: "devnet", holdSecs: 120 };
    const ix = createCampaignIx(a);
    const bn = (await_: bigint) => new (require("bn.js"))(await_.toString());
    const want = coder.encode("create_campaign", { campaign_id: bn(a.campaignId), commission_bps: a.commissionBps, commission_budget: bn(a.budget), attribution_key: a.attributionKey, cluster: Array.from(Buffer.concat([Buffer.from("devnet"), Buffer.alloc(2)])), hold_secs: a.holdSecs });
    expect(Buffer.from(ix.data).toString("hex")).toBe(want.toString("hex"));
    const names = idl.instructions.find((i: any) => i.name === "create_campaign").accounts.map((x: any) => x.name);
    expect(names).toEqual(["merchant", "mint", "config", "campaign", "system_program"]);
    expect(ix.keys.map((x) => x.pubkey.toBase58())).toEqual([a.merchant, USDC_MINT, configPda(), campaignPda(a.merchant, a.campaignId), PublicKey.default].map((x) => x.toBase58()));
    expect(ix.keys[0]).toMatchObject({ isSigner: true, isWritable: true }); expect(ix.keys[3].isWritable).toBe(true);
  });
  it("refund_sale accounts follow the IDL order (merchant signs; campaign, sale, vault, buyer ATA, rent payer writable)", () => {
    const names = idl.instructions.find((i: any) => i.name === "refund_sale").accounts.map((x: any) => x.name);
    expect(names).toEqual(["merchant", "campaign", "sale", "sale_vault", "buyer_ata", "rent_payer", "token_program"]);
    const [m, c, s, b, r] = [k(), k(), k(), k(), k()];
    const ix = refundSaleIx({ merchant: m, campaign: c, sale: s, buyer: b, rentPayer: r });
    expect(ix.keys.map((x) => x.pubkey.toBase58()).slice(0, 6)).toEqual([m, c, s, ata(s), ata(b), r].map((x) => x.toBase58()));
    expect(ix.keys.map((x) => [x.isSigner, x.isWritable])).toEqual([[true, false], [false, true], [false, true], [false, true], [false, true], [false, true], [false, false]]);
    expect(Buffer.from(ix.data).toString("hex")).toBe(Buffer.from(DISC.refundSale).toString("hex"));
    expect(ix.programId.equals(PROGRAM_ID)).toBe(true);
  });
  it("rejects out-of-range terms before anything is signed", () => {
    const base = { merchant: k(), campaignId: 1n, commissionBps: 1500, budget: 1n, attributionKey: k(), cluster: "devnet", holdSecs: 15 };
    expect(() => createCampaignIx({ ...base, commissionBps: 5001 })).toThrow(); expect(() => createCampaignIx({ ...base, holdSecs: 601 })).toThrow(); expect(() => createCampaignIx({ ...base, cluster: "toolongcluster" })).toThrow();
  });
});

describe("amounts", () => {
  it("parses decimals exactly and rejects junk", () => {
    expect(parseAmount("50")).toBe(50_000_000n); expect(parseAmount("0.000001")).toBe(1n); expect(parseAmount("1,204.55")).toBe(1_204_550_000n); expect(parseAmount("0.1")).toBe(100_000n);
    for (const bad of ["", "-1", "1e3", "1.2.3", "0.0000001", "abc"]) expect(() => parseAmount(bad)).toThrow();
  });
});

describe("listing message matches the server's canonical form", () => {
  it("same canonical JSON and hash as packages/core (sorted keys, website only when present)", async () => {
    const l = { name: "N", description: "D", category: "data-feeds", endpointUrl: "https://x.dev/a", route: "GET /a", displayPrice: "$0.10", isSample: false };
    expect(canonicalListing(l)).toBe('{"category":"data-feeds","description":"D","displayPrice":"$0.10","endpointUrl":"https://x.dev/a","isSample":false,"name":"N","route":"GET /a"}');
    expect(canonicalListing({ ...l, website: "https://x.dev" })).toContain('"website":"https://x.dev"');
    const campaign = k().toBase58();
    const core = await import("../../../packages/core/src/listing");
    const want = core.listingMessage({ campaign: new PublicKey(campaign), listing: l as any, ts: 1_800_000_000 });
    expect(Buffer.from(await listingMessage(campaign, l, 1_800_000_000)).toString("hex")).toBe(want.toString("hex"));
  });
});

describe("top_up_budget and set_attribution_key builders", () => {
  const BN = require("bn.js");
  it("top_up_budget data is byte-identical to Anchor's encoding; accounts follow the IDL (merchant signs, campaign writable)", () => {
    const [m, c] = [k(), k()]; const ix = topUpBudgetIx({ merchant: m, campaign: c, amount: 12_345_678_901n });
    expect(Buffer.from(ix.data).toString("hex")).toBe(coder.encode("top_up_budget", { amount: new BN("12345678901") }).toString("hex"));
    expect(idl.instructions.find((i: any) => i.name === "top_up_budget").accounts.map((x: any) => x.name)).toEqual(["merchant", "campaign"]);
    expect(ix.keys.map((x) => [x.pubkey.toBase58(), x.isSigner, x.isWritable])).toEqual([[m.toBase58(), true, false], [c.toBase58(), false, true]]);
  });
  it("top_up_budget refuses zero and anything that does not fit a u64, before a wallet is involved", () => {
    expect(() => topUpBudgetIx({ merchant: k(), campaign: k(), amount: 0n })).toThrow(/greater than zero/);
    expect(() => topUpBudgetIx({ merchant: k(), campaign: k(), amount: 1n << 64n })).toThrow();
    expect(topUpBudgetIx({ merchant: k(), campaign: k(), amount: (1n << 64n) - 1n }).data.length).toBe(16);
  });
  it("set_attribution_key data is byte-identical to Anchor's encoding; the all-zero key is refused client-side", () => {
    const [m, c, key] = [k(), k(), k()]; const ix = setAttributionKeyIx({ merchant: m, campaign: c, newKey: key });
    expect(Buffer.from(ix.data).toString("hex")).toBe(coder.encode("set_attribution_key", { new_key: key }).toString("hex"));
    expect(idl.instructions.find((i: any) => i.name === "set_attribution_key").accounts.map((x: any) => x.name)).toEqual(["merchant", "campaign"]);
    expect(() => setAttributionKeyIx({ merchant: m, campaign: c, newKey: PublicKey.default })).toThrow(/all-zero/);
  });
});
