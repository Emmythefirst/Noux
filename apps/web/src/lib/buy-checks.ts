// What the buy page verifies about a service's 402 answer BEFORE it asks the wallet to pay. The 402 comes from the merchant's own server, so on its own it is only a claim:
// without these checks a listed endpoint could ask for a different token or a different amount than the listing advertises.

/** CAIP-2 network ids the x402 `exact` Solana scheme uses, by wallet-standard chain. */
const X402_NETWORK: Record<string, string> = {
  "solana:devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  "solana:mainnet": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
};

export interface Requirement { scheme: string; network: string; amount: string; asset: string; payTo: string }

/** Whole numbers in a display price: "$0.10" -> [0.1]; "$0.03-$0.10" -> [0.03, 0.1]; "free" -> []. */
export function priceNumbers(displayPrice: string | null | undefined): number[] {
  return (displayPrice ?? "").match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
}

/**
 * Returns a plain-language reason NOT to pay, or null when the 402 matches what the campaign and its listing say.
 *  - the token must be the campaign's token (a merchant can create a campaign with any mint, and an endpoint could ask for another one)
 *  - the network must be the one this site is on
 *  - the amount must equal the listed price, or fall inside a listed range; a listing with no readable number cannot be compared and is not blocked
 */
export function checkRequirement(req: Requirement, ctx: { campaignMint: string; decimals: number; chain: string; displayPrice: string | null | undefined }): string | null {
  if (req.scheme !== "exact") return `The service asks for a payment scheme (“${req.scheme}”) this page does not support. Nothing was sent.`;
  const expectedNet = X402_NETWORK[ctx.chain];
  if (expectedNet && req.network !== expectedNet) return "The service asks for payment on a different network than this site is on. Nothing was sent.";
  if (req.asset !== ctx.campaignMint) return "The service asks for a different token than this campaign uses. Nothing was sent.";
  if (!/^\d{1,20}$/.test(req.amount)) return "The service did not give a valid price. Nothing was sent.";
  const nums = priceNumbers(ctx.displayPrice);
  if (nums.length >= 1) {
    const asked = Number(req.amount) / 10 ** ctx.decimals, lo = Math.min(...nums), hi = Math.max(...nums), eps = 0.5 / 10 ** ctx.decimals;
    if (asked < lo - eps || asked > hi + eps) {
      const shown = asked.toFixed(Math.min(ctx.decimals, 6)).replace(/0+$/, "").replace(/\.$/, "");
      return `The service asks for ${shown} but its listing says ${ctx.displayPrice}. Nothing was sent. If the price changed, the merchant needs to update the listing.`;
    }
  }
  return null;
}
