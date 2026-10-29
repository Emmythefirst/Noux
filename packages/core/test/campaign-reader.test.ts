import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { OnchainCampaignReader, idl } from "../src";

const programId = new PublicKey((idl as any).address);
const coder = new anchor.BorshAccountsCoder(idl as anchor.Idl);
const pk = () => Keypair.generate().publicKey;
async function campaignData() {
  return coder.encode("Campaign", { merchant: pk(), mint: pk(), fee_owner: pk(), attribution_key: pk(), cluster: [...Buffer.from("devnet\0\0")], hold_secs: 15, settled_count: new anchor.BN(0), refunded_count: new anchor.BN(0), campaign_id: new anchor.BN(1), commission_budget: new anchor.BN(1000), commission_spent: new anchor.BN(0), commission_bps: 1500, fee_bps: 100, bump: 255 });
}
function reader(opts: { ms?: number } = {}) {
  const state = { calls: 0, fail: false, data: null as Buffer | null, control: null as { owner: PublicKey; data: Buffer } | null };
  // one batched call returns [campaign, control]: the control account usually does not exist
  const conn: any = { getMultipleAccountsInfo: async (keys: PublicKey[]) => { state.calls++; await new Promise((r) => setTimeout(r, opts.ms ?? 10)); if (state.fail) throw new TypeError("fetch failed"); expect(keys.length).toBe(2); return [state.data ? { owner: programId, data: state.data } : null, state.control]; } };
  return { r: new OnchainCampaignReader(conn, programId, 50, 50), state };
}
const controlData = (st: "Active" | "Paused" | "Ended") => coder.encode("CampaignControl", { campaign: pk(), state: { [st]: {} }, bump: 255 });

describe("OnchainCampaignReader under load and RPC trouble", () => {
  it("100 concurrent cold reads make ONE chain read (single flight)", async () => {
    const { r, state } = reader(); state.data = await campaignData(); const a = pk();
    const out = await Promise.all(Array.from({ length: 100 }, () => r.get(a)));
    expect(state.calls).toBe(1); expect(out.every((x) => x && x.cluster === "devnet")).toBe(true);
  });
  it("after the cache expires, a burst again costs one read, not one per caller", async () => {
    const { r, state } = reader(); state.data = await campaignData(); const a = pk();
    await r.get(a); await new Promise((x) => setTimeout(x, 70)); const before = state.calls;
    await Promise.all(Array.from({ length: 50 }, () => r.get(a))); expect(state.calls - before).toBe(1);
  });
  it("if the refresh fails, the last good copy is served (a campaign's key and merchant never change)", async () => {
    const { r, state } = reader(); state.data = await campaignData(); const a = pk();
    const first = await r.get(a); await new Promise((x) => setTimeout(x, 70)); state.fail = true;
    const second = await r.get(a); expect(second?.attributionKey.equals(first!.attributionKey)).toBe(true);
  });
  it("with nothing cached, an RPC failure still throws (we never invent a campaign) and does not poison later reads", async () => {
    const { r, state } = reader(); state.data = await campaignData(); state.fail = true; const a = pk();
    await expect(r.get(a)).rejects.toThrow("fetch failed"); state.fail = false;
    expect((await r.get(a))?.cluster).toBe("devnet");
  });
  it("a failed concurrent burst fails every caller once, then the next call retries (no stuck in-flight entry)", async () => {
    const { r, state } = reader(); state.data = await campaignData(); state.fail = true; const a = pk();
    const res = await Promise.allSettled(Array.from({ length: 20 }, () => r.get(a))); expect(res.every((x) => x.status === "rejected")).toBe(true); expect(state.calls).toBe(1);
    state.fail = false; expect((await r.get(a))?.cluster).toBe("devnet");
  });
  it("an account that is not a campaign is still null (negative result is cached briefly, not served stale as a campaign)", async () => {
    const { r, state } = reader(); state.data = null; expect(await r.get(pk())).toBeNull();
    const a = pk(); state.data = Buffer.alloc(10); expect(await r.get(a)).toBeNull();
  });

  it("the campaign's state comes from its control account: none means active, Paused and Ended are read, a foreign or malformed account means active (as the program does)", async () => {
    const a = pk(); const { r, state } = reader(); state.data = await campaignData();
    expect((await r.get(a))?.state).toBe("active");
    for (const [st, want] of [["Active", "active"], ["Paused", "paused"], ["Ended", "ended"]] as const) {
      const rr = reader(); rr.state.data = state.data; rr.state.control = { owner: programId, data: await controlData(st) };
      expect((await rr.r.get(pk()))?.state).toBe(want);
    }
    const foreign = reader(); foreign.state.data = state.data; foreign.state.control = { owner: pk(), data: await controlData("Paused") };
    expect((await foreign.r.get(pk()))?.state).toBe("active"); // owned by someone else: not our control account
    const junk = reader(); junk.state.data = state.data; junk.state.control = { owner: programId, data: Buffer.alloc(40) };
    expect((await junk.r.get(pk()))?.state).toBe("active");
  });
  it("reading the state costs no extra RPC call: still ONE call per refresh, shared by concurrent callers", async () => {
    const { r, state } = reader(); state.data = await campaignData(); state.control = { owner: programId, data: await controlData("Paused") }; const a = pk();
    const out = await Promise.all(Array.from({ length: 40 }, () => r.get(a))); expect(state.calls).toBe(1); expect(out.every((x) => x?.state === "paused")).toBe(true);
  });
});
