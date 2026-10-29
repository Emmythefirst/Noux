import { describe, it, expect } from "vitest";
import { ResilientFacilitator, isAmbiguous, type LandedCheck } from "../src";

const payload: any = { x402Version: 2, payload: { transaction: "BASE64-SIGNED-BY-BUYER" } };
const reqs: any = { scheme: "exact", network: "solana:devnet", amount: "100000", payTo: "SALE", asset: "MINT" };
const noSleep = async () => {};

function inner(script: Array<"ok" | "netfail" | "reject" | "badstatus">, calls: any[] = []) {
  let i = 0;
  return {
    calls,
    verify: async (p: any) => { calls.push(["verify", p]); const s = script[i++] ?? "ok"; if (s === "netfail") throw new TypeError("fetch failed"); if (s === "reject") throw new Error("invalid_exact_svm_payload"); return { isValid: true, payer: "P" }; },
    settle: async (p: any) => { calls.push(["settle", p]); const s = script[i++] ?? "ok"; if (s === "netfail") throw new TypeError("fetch failed"); if (s === "badstatus") return { success: false, errorReason: "insufficient_funds", transaction: "", network: "n" }; if (s === "reject") throw new Error("facilitator said no"); return { success: true, payer: "P", transaction: "SIG", network: "n" }; },
    getSupported: async () => { calls.push(["supported"]); const s = script[i++] ?? "ok"; if (s === "netfail") throw new TypeError("fetch failed"); return { kinds: [], extensions: [], signers: {} }; },
  } as any;
}
const mk = (i: any, landed: (n: number) => LandedCheck, events: any[] = []) => {
  let n = 0;
  return new ResilientFacilitator(i, { sleep: noSleep, confirmDelaysMs: [1, 1], confirmLanded: async () => landed(n++), onEvent: (e) => events.push(e) });
};

describe("isAmbiguous", () => {
  it("flags network/5xx/timeout trouble, not definitive refusals", () => {
    for (const m of ["fetch failed", "ETIMEDOUT", "socket hang up", "503 Service Unavailable", "Too Many Requests", "request timed out"]) expect(isAmbiguous(new Error(m))).toBe(true);
    for (const m of ["invalid_exact_svm_payload", "insufficient_funds", "payer_mismatch"]) expect(isAmbiguous(new Error(m))).toBe(false);
  });
});

describe("verify / getSupported (idempotent reads)", () => {
  it("retries ambiguous failures, then succeeds", async () => {
    const calls: any[] = []; const f = mk(inner(["netfail", "netfail", "ok"], calls), () => ({ landed: false }));
    expect((await f.verify(payload, reqs)).isValid).toBe(true);
    expect(calls.filter((c) => c[0] === "verify").length).toBe(3);
  });
  it("does not retry a definitive rejection", async () => {
    const calls: any[] = []; const f = mk(inner(["reject"], calls), () => ({ landed: false }));
    await expect(f.verify(payload, reqs)).rejects.toThrow("invalid_exact_svm_payload");
    expect(calls.length).toBe(1);
  });
  it("gives up after maxAttempts", async () => {
    const calls: any[] = []; const f = mk(inner(Array(10).fill("netfail"), calls), () => ({ landed: false }));
    await expect(f.getSupported()).rejects.toThrow("fetch failed");
    expect(calls.length).toBe(4);
  });
});

describe("settle: never blind-retry, never re-sign", () => {
  it("happy path settles once with no chain check", async () => {
    const calls: any[] = []; let checks = 0; const f = mk(inner(["ok"], calls), () => { checks++; return { landed: false }; });
    expect((await f.settle(payload, reqs)).success).toBe(true);
    expect(calls.length).toBe(1); expect(checks).toBe(0);
  });
  it("timed-out settle that ALREADY LANDED is reported as success and is NOT resubmitted", async () => {
    const calls: any[] = []; const events: any[] = [];
    const f = mk(inner(["netfail"], calls), () => ({ landed: true, transaction: "CHAINSIG", payer: "BUYER" }), events);
    const r = await f.settle(payload, reqs);
    expect(r).toMatchObject({ success: true, transaction: "CHAINSIG", payer: "BUYER" });
    expect(calls.filter((c) => c[0] === "settle").length).toBe(1); // exactly one submission, no duplicate
    expect(events.some((e) => e.type === "settle_already_landed")).toBe(true);
  });
  it("lands late: first look says no, a later look says yes => no resubmission", async () => {
    const calls: any[] = [];
    const f = mk(inner(["netfail"], calls), (n) => (n === 0 ? { landed: false } : { landed: true, transaction: "LATE" }));
    expect((await f.settle(payload, reqs)).transaction).toBe("LATE");
    expect(calls.filter((c) => c[0] === "settle").length).toBe(1);
  });
  it("confirmed NOT landed => resubmits the IDENTICAL payload object (no re-signing)", async () => {
    const calls: any[] = []; const f = mk(inner(["netfail", "ok"], calls), () => ({ landed: false }));
    expect((await f.settle(payload, reqs)).success).toBe(true);
    const settles = calls.filter((c) => c[0] === "settle");
    expect(settles.length).toBe(2);
    expect(settles[0][1]).toBe(settles[1][1]); // same reference: untouched payload, same buyer signature
    expect(settles[1][1].payload.transaction).toBe("BASE64-SIGNED-BY-BUYER");
  });
  it("unknown chain state => refuses to retry blindly and surfaces an error", async () => {
    const calls: any[] = []; const f = mk(inner(["netfail", "ok"], calls), () => ({ landed: "unknown" }));
    await expect(f.settle(payload, reqs)).rejects.toThrow(/unknown/);
    expect(calls.filter((c) => c[0] === "settle").length).toBe(1);
  });
  it("a throwing chain check counts as unknown, not as 'not landed'", async () => {
    const calls: any[] = [];
    const f = new ResilientFacilitator(inner(["netfail", "ok"], calls), { sleep: noSleep, confirmDelaysMs: [1], confirmLanded: async () => { throw new Error("rpc down"); } });
    await expect(f.settle(payload, reqs)).rejects.toThrow(/unknown/);
    expect(calls.filter((c) => c[0] === "settle").length).toBe(1);
  });
  it("definitive facilitator refusal (success:false) is returned as-is, never retried", async () => {
    const calls: any[] = []; let checks = 0; const f = mk(inner(["badstatus"], calls), () => { checks++; return { landed: false }; });
    const r = await f.settle(payload, reqs);
    expect(r.success).toBe(false); expect(calls.length).toBe(1); expect(checks).toBe(0);
  });
  it("a thrown definitive rejection is not retried and not chain-checked", async () => {
    const calls: any[] = []; let checks = 0; const f = mk(inner(["reject"], calls), () => { checks++; return { landed: false }; });
    await expect(f.settle(payload, reqs)).rejects.toThrow("facilitator said no");
    expect(calls.length).toBe(1); expect(checks).toBe(0);
  });
  it("bounded: persistent ambiguity with confirmed-absent gives up after maxSettleAttempts", async () => {
    const calls: any[] = []; const f = mk(inner(Array(10).fill("netfail"), calls), () => ({ landed: false }));
    await expect(f.settle(payload, reqs)).rejects.toThrow("fetch failed");
    expect(calls.filter((c) => c[0] === "settle").length).toBe(3);
  });
});

describe("settle: 'did not confirm in time' is AMBIGUOUS (the payment may still land), not a definitive refusal", () => {
  const PENDING = { errorReason: "settlement_pending", errorMessage: "transaction did not confirm in time: context deadline exceeded" };
  /** facilitator whose settle answers `pending` first (as a returned failure or a thrown error), then `ok` */
  function pendingThenOk(kind: "returned" | "thrown", calls: any[]) {
    let n = 0;
    return { calls, verify: async () => ({ isValid: true }), getSupported: async () => ({ kinds: [], extensions: [], signers: {} }),
      settle: async (p: any) => { calls.push(["settle", p]); if (n++ === 0) { if (kind === "thrown") throw new Error(`${PENDING.errorReason}: ${PENDING.errorMessage}`); return { success: false, ...PENDING, transaction: "", network: "n" }; } return { success: true, transaction: "RESUBMITTED", payer: "BUYER", network: "n" }; } } as any;
  }
  for (const kind of ["returned", "thrown"] as const) {
    it(`(${kind}) if it landed in the meantime: success from the chain, and NOTHING is resubmitted`, async () => {
      const calls: any[] = []; const events: any[] = [];
      const f = mk(pendingThenOk(kind, calls), () => ({ landed: true, transaction: "CHAINSIG", payer: "BUYER" }), events);
      expect(await f.settle(payload, reqs)).toMatchObject({ success: true, transaction: "CHAINSIG" });
      expect(calls.filter((c) => c[0] === "settle").length).toBe(1); expect(events.some((e) => e.type === "settle_already_landed")).toBe(true);
    });
    it(`(${kind}) if the chain confirms it is NOT there, the IDENTICAL payload is resubmitted once and the buyer is served`, async () => {
      const calls: any[] = []; const f = mk(pendingThenOk(kind, calls), () => ({ landed: false }));
      const r = await f.settle(payload, reqs);
      expect(r).toMatchObject({ success: true, transaction: "RESUBMITTED" });
      const settles = calls.filter((c) => c[0] === "settle"); expect(settles.length).toBe(2); expect(settles[1][1]).toBe(settles[0][1]); // same object: never re-signed
    });
    it(`(${kind}) if the chain cannot be read, it does not guess: the error surfaces and nothing is resubmitted`, async () => {
      const calls: any[] = []; const f = mk(pendingThenOk(kind, calls), () => ({ landed: "unknown" }));
      await expect(f.settle(payload, reqs)).rejects.toThrow(/unknown|not retrying/i); expect(calls.filter((c) => c[0] === "settle").length).toBe(1);
    });
  }
  it("a genuine refusal (insufficient_funds) is still definitive: returned untouched, no chain check, no retry", async () => {
    const calls: any[] = []; let checks = 0; const f = mk(inner(["badstatus"], calls), () => { checks++; return { landed: false }; });
    expect((await f.settle(payload, reqs)).success).toBe(false); expect(calls.length).toBe(1); expect(checks).toBe(0);
  });
  it("isAmbiguous knows the facilitator's wording", () => {
    for (const m of ["settlement_pending: transaction did not confirm in time: context deadline exceeded", "transaction did not confirm in time", "context deadline exceeded"]) expect(isAmbiguous(new Error(m))).toBe(true);
  });
});
