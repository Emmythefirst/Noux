// Checks that turn a wallet-specific failure into a message a person can act on. Pure, so they are unit-tested without a wallet.

/** Why this wallet/account cannot sign for `chain` (e.g. "solana:devnet"), or null when it can. */
export function chainProblem(walletChains: readonly string[], accountChains: readonly string[], chain: string): string | null {
  if (accountChains.length ? accountChains.includes(chain) : walletChains.includes(chain)) return null;
  const net = chain.split(":")[1] ?? chain;
  return `This wallet does not offer Solana ${net}. Switch it to ${net} (in its settings, often under developer or testnet mode) or use a wallet that supports it.`;
}

export const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The x402 payment is built by the library; the wallet's answer is used only for the buyer's signature. A wallet that edits the
 * transaction before signing (some add safety instructions) signs different bytes, so its signature would not match what the
 * facilitator receives. Say so instead of sending a payment that is certain to be refused.
 */
export function assertWalletSignedSameMessage(original: Uint8Array, signed: Uint8Array) {
  if (!sameBytes(original, signed)) throw new Error("Your wallet changed the payment transaction before signing it (some wallets add their own safety instructions), so the payment cannot be verified. Nothing was sent. Try a different wallet.");
}
