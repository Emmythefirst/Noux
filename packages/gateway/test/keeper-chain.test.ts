import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { idl } from "@noux/core";
import { AnchorKeeperChain, SALE_STATUS_OFFSET, OPEN_STATUS_B58 } from "../src/chain";

const coder = new anchor.BorshAccountsCoder(idl as anchor.Idl);
const pk = () => Keypair.generate().publicKey;
const base = {
  campaign: pk(), distributor: pk(), buyer: pk(), rentPayer: pk(), nonce: [...new Uint8Array(32)], expiry: new anchor.BN(1), openedAt: new anchor.BN(2), holdUntil: new anchor.BN(3), settledAt: new anchor.BN(4),
  price: new anchor.BN(5), gross: new anchor.BN(6), merchantAmount: new anchor.BN(7), commissionAmount: new anchor.BN(8), feeAmount: new anchor.BN(9), commissionBps: 10, feeBps: 11, bump: 255,
};
const sale = (status: object) => ({ ...base, status });

describe("keeper scan only downloads OPEN sales", () => {
  it("SALE_STATUS_OFFSET is the status byte of the real Sale layout (derived by diffing encodings)", async () => {
    const o = await coder.encode("Sale", sale({ Open: {} })), s = await coder.encode("Sale", sale({ Settled: {} })), r = await coder.encode("Sale", sale({ Refunded: {} }));
    // same fields, only the status differs => exactly one byte differs, and it is at the constant offset
    const diff = [...o].map((b, i) => (b !== s[i] ? i : -1)).filter((i) => i >= 0);
    expect(diff).toEqual([SALE_STATUS_OFFSET]);
    expect(o[SALE_STATUS_OFFSET]).toBe(0); expect(s[SALE_STATUS_OFFSET]).toBe(1); expect(r[SALE_STATUS_OFFSET]).toBe(2);
    expect(Buffer.from(anchor.utils.bytes.bs58.decode(OPEN_STATUS_B58))).toEqual(Buffer.from([0]));
    expect(o.length).toBe(246); // size the dataSize filter relies on
  });
  it("listOpenSales asks the RPC for status == Open and still decodes what comes back", async () => {
    let seen: any;
    const openAcct = await coder.encode("Sale", sale({ Open: {} }));
    const connection: any = { getProgramAccounts: async (_p: PublicKey, cfg: any) => { seen = cfg; return [{ pubkey: pk(), account: { data: openAcct } }]; } };
    const chain = new AnchorKeeperChain({ connection, programId: new PublicKey((idl as any).address), mint: pk(), payer: Keypair.generate() });
    const out = await chain.listOpenSales();
    expect(seen.filters).toContainEqual({ memcmp: { offset: SALE_STATUS_OFFSET, bytes: OPEN_STATUS_B58 } });
    expect(seen.filters.some((f: any) => f.dataSize === 246)).toBe(true);
    expect(out.length).toBe(1); expect(out[0].price).toBe(5n);
  });
});
