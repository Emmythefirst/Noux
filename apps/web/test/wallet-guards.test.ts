import { describe, it, expect } from "vitest";
import { chainProblem, assertWalletSignedSameMessage, sameBytes } from "../src/lib/wallet-guards";

describe("wallet guards", () => {
  it("chainProblem: null when the account (or, lacking account chains, the wallet) offers the chain", () => {
    expect(chainProblem(["solana:mainnet"], ["solana:mainnet", "solana:devnet"], "solana:devnet")).toBeNull();
    expect(chainProblem(["solana:devnet"], [], "solana:devnet")).toBeNull();
  });
  it("chainProblem: a mainnet-only wallet gets a message naming the network, not an opaque signing error", () => {
    const m = chainProblem(["solana:mainnet"], ["solana:mainnet"], "solana:devnet");
    expect(m).toMatch(/does not offer Solana devnet/); expect(m).toMatch(/Switch it to devnet/);
  });
  it("chainProblem: the ACCOUNT's chains win over the wallet's (the wallet may list a chain this account lacks)", () => {
    expect(chainProblem(["solana:devnet"], ["solana:mainnet"], "solana:devnet")).not.toBeNull();
  });
  it("assertWalletSignedSameMessage: identical bytes pass", () => {
    expect(() => assertWalletSignedSameMessage(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).not.toThrow();
  });
  it("assertWalletSignedSameMessage: a wallet that added an instruction (longer message) or changed a byte is refused with a clear message", () => {
    expect(() => assertWalletSignedSameMessage(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3, 4]))).toThrow(/changed the payment transaction/);
    expect(() => assertWalletSignedSameMessage(new Uint8Array([1, 2, 3]), new Uint8Array([1, 9, 3]))).toThrow(/Nothing was sent/);
    expect(sameBytes(new Uint8Array(), new Uint8Array())).toBe(true);
  });
});
