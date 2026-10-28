import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import { verifyReceipt } from "../src/lib/verify";

// Opt-in: needs a sale whose open and payment transactions are v0 transactions using an address lookup table.
//   apps/api/scripts/alt-sale-local.ts builds one on a local validator and writes the fixture;
//   run:  ALT_FIXTURE=/path/fixture.json ALT_RPC=http://127.0.0.1:8899 pnpm vitest run test/verify-alt.test.ts
const fixturePath = process.env.ALT_FIXTURE;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe.skipIf(!fixturePath)("receipt verification on transactions that use an address lookup table (real transactions)", () => {
  const f = fixturePath ? JSON.parse(fs.readFileSync(fixturePath, "utf8")) : null;
  const point = () => { globalThis.fetch = ((_u: any, init: any) => realFetch(process.env.ALT_RPC ?? "http://127.0.0.1:8899", init)) as typeof fetch; };
  const input = (over: Record<string, unknown> = {}) => ({ sale: f.sale, openTx: `https://explorer.solana.com/tx/${f.openSig}`, paymentTx: `https://explorer.solana.com/tx/${f.paySig}`, apiGross: f.gross, apiSplit: f.split, ...over });

  it("the fixture's transactions really are v0 with lookups (otherwise nothing below means anything)", () => {
    expect(f.usedAlt.open).toMatchObject({ version: 0 }); expect(f.usedAlt.open.lookups).toBeGreaterThan(0); expect(f.usedAlt.open.loaded).toBeGreaterThan(0);
    expect(f.usedAlt.pay).toMatchObject({ version: 0 }); expect(f.usedAlt.pay.lookups).toBeGreaterThan(0);
  });
  it("all four checks pass", async () => {
    point();
    const r = await verifyReceipt(input());
    expect(r.map((x) => x.state)).toEqual(["pass", "pass", "pass", "pass"]);
  });
  it("still catches a lie: another sale's open transaction is refused for check 1 even though both use lookup tables", async () => {
    point();
    const r = await verifyReceipt(input({ openTx: `https://explorer.solana.com/tx/${f.paySig}` })); // a real v0 tx, but not the open transaction
    expect(r[0].state).toBe("fail");
  });
  it("still catches a page that lies about the split", async () => {
    point();
    const r = await verifyReceipt(input({ apiSplit: { ...f.split, merchant: "90000" } }));
    expect(r[2].state).toBe("fail");
  });
});
