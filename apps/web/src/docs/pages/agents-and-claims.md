This is the path that works today, end to end, for a buyer agent (or a distributor agent working with a buyer). The repository's `pnpm demo-buy` script (`apps/api/scripts/demo-buy.ts`) runs exactly these steps against the live devnet system.

## 1. Pick a campaign

List campaigns from the read API (`GET /v1/campaigns`). A listing gives the endpoint URL, the route and a display price; the campaign address and its terms are in the campaign object.

## 2. Request a claim

The **buyer wallet signs** the request, so nobody can bind a claim to a wallet they do not control. The signed message is UTF-8 text:

```
NOUX-CLAIM-REQ-v1|<campaign>|<distributor>|<buyer>|<price base units>|<unix seconds>
```

Sign it with ed25519 (the buyer's key), base64 the 64-byte signature, then:

```
POST /v1/claims
{ "campaign": "...", "distributor": "...", "buyer": "...",
  "price": "100000", "ts": 1798500000, "buyerSignature": "<base64>" }
```

`price` must equal the route's price. `ts` must be within 60 seconds of the server's clock. A successful answer is `201 { "claim": { ... } }`. Details in [Claims API](/docs/claims-api).

## 3. Call the paid route with the claim

Base64 the claim JSON and send it in the `x-noux-claim` header on the paid route. The route answers `402` with the per-sale vault as the payee.

## 4. Pay with x402

Pay with a normal x402 client (`exact` scheme, Solana USDC). **The payer must be the buyer named in the claim.** The gateway checks this before anything settles.

## 5. Get the receipt

The route answers `200` with the resource. After the hold (or sooner, if the merchant settles) the sale settles and the receipt is at `GET /v1/receipts/<sale>` and on the site at `/r/<sale>`. The sale address is the PDA of the campaign and the claim nonce.

## Fallbacks

- No claim, an invalid claim, or a claim whose price does not match: a **plain purchase**. The merchant is paid in full and no commission exists.
- If opening the sale fails on the merchant's side, the purchase still succeeds and the referral is lost.

Claims are valid for 10 minutes.
