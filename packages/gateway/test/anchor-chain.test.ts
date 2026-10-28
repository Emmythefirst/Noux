import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { LocalKeySigner, signClaim, idl } from "@noux/core";
import { AnchorChain } from "../src/chain";

const programId = new PublicKey((idl as any).address), campaign = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
const attest = new LocalKeySigner(Keypair.generate().secretKey);
const claim = (expiry: number) => signClaim(attest, { programId, cluster: "devnet", campaign, distributor: Keypair.generate().publicKey, buyer: Keypair.generate().publicKey, expiry, price: 1000n, nonce: nacl.randomBytes(32) } as any);

function chain(opts: { existing?: boolean; sendMs?: number } = {}) {
  const calls = { getAccountInfo: 0, open: 0, campaignFetch: 0 };
  const connection: any = { getAccountInfo: async () => { calls.getAccountInfo++; return opts.existing ? { data: Buffer.alloc(1) } : null; } };
  const c = new AnchorChain({ connection, programId, mint, gatewayPayer: Keypair.generate(), inflightWindowMs: 20 });
  (c as any).program = {
    methods: { openSale: () => ({ accounts: () => ({ preInstructions: () => ({ rpc: async () => { calls.open++; await new Promise((r) => setTimeout(r, opts.sendMs ?? 0)); return "sig"; } }) }) }) },
    account: { campaign: { fetch: async () => { calls.campaignFetch++; return { merchant: Keypair.generate().publicKey, feeOwner: Keypair.generate().publicKey }; } } },
  };
  return { c, calls };
}
const future = () => Math.floor(Date.now() / 1000) + 600;

describe("AnchorChain RPC economy (each saved call matters: purchases are RPC-bound)", () => {
  it("concurrent opens of one claim send ONE transaction", async () => {
    const { c, calls } = chain({ sendMs: 30 }); const cl = await claim(future());
    await Promise.all(Array.from({ length: 25 }, () => c.ensureOpen(cl)));
    expect(calls.open).toBe(1); expect(calls.getAccountInfo).toBe(1);
  });
  it("the paid retry of the same request does not read the chain again once the sale is known open", async () => {
    const { c, calls } = chain(); const cl = await claim(future());
    await c.ensureOpen(cl); await new Promise((r) => setTimeout(r, 80)); // past the in-flight window
    await c.ensureOpen(cl);
    expect(calls.open).toBe(1); expect(calls.getAccountInfo).toBe(1);
  });
  it("a sale found already open is remembered too (another gateway instance opened it)", async () => {
    const { c, calls } = chain({ existing: true }); const cl = await claim(future());
    await c.ensureOpen(cl); await new Promise((r) => setTimeout(r, 80)); await c.ensureOpen(cl);
    expect(calls.open).toBe(0); expect(calls.getAccountInfo).toBe(1);
  });
  it("the memory ends with the claim: an entry whose claim expired is re-checked on the chain (the sale may have been closed)", async () => {
    const { c, calls } = chain(); const cl = await claim(Math.floor(Date.now() / 1000) + 1);
    await c.ensureOpen(cl); await new Promise((r) => setTimeout(r, 1_300)); // claim expired AND in-flight window over
    await c.ensureOpen(cl);
    expect(calls.getAccountInfo).toBe(2);
  });
  it("settle fetches the campaign once, not once per sale", async () => {
    const { c, calls } = chain(); (c as any).o.merchant = Keypair.generate();
    (c as any).program.methods.settleSale = () => ({ accounts: () => ({ preInstructions: () => ({ signers: () => ({ rpc: async () => "s" }) }) }) });
    for (let i = 0; i < 5; i++) await c.settle(await claim(future()));
    expect(calls.campaignFetch).toBe(1);
  });
});
