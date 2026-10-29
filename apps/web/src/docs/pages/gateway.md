The gateway is Express middleware that makes a paid x402 route referral-aware. It wraps `@x402/express`: your route keeps working exactly as before, and gains a second behaviour when a valid claim arrives.

> **Note** `@noux/gateway` is a package in this repository, not yet published to npm. The sample merchant (`apps/demo-merchant`) is the reference integration; the snippets below follow it.

## What you need

- A paid x402 route on Solana, and an x402 facilitator account (the sample merchant uses Coinbase CDP).
- A **campaign** created from the merchant console. You pass its address to the gateway.
- A **gateway payer key**: a small SOL-funded keypair on your server. It pays the rent when a referred sale opens: about 0.0034 SOL at today's devnet rates, of which the vault part (about 0.0015 SOL) comes back when the sale settles and the receipt part (about 0.0019 SOL) **stays locked in the sale's on-chain receipt for good**. An unpaid sale that expires is closed and all of it returns. For a very cheap endpoint the permanent part can exceed the price of one call, so price referred routes with that in mind. It cannot refund and cannot touch your earnings.
- Optionally a **merchant signer key**. If you provide it the gateway settles each sale right after you deliver (in the background: the buyer's response does not wait for it); without it the [keeper](/docs/keeper) settles after the hold.

## Wiring it up

```ts
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { OnchainCampaignReader } from "@noux/core";
import { AnchorChain, createNouxGateway } from "@noux/gateway";

const connection = new Connection(RPC_URL, "confirmed");
const chain = new AnchorChain({ connection, programId, mint, gatewayPayer, merchant /* optional */ });

const gateway = createNouxGateway({
  programId, cluster: "devnet", campaign, mint,
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",   // devnet
  merchantPayTo,                                         // paid in full when there is no valid claim
  facilitator, connection,
  campaigns: new OnchainCampaignReader(connection, programId),
  opener: chain,
  settler: merchant ? chain : undefined,                 // settle right after delivery
  routes: { "GET /v1/brief": { price: 100_000n } },      // base units: 100000 = 0.10 USDC
  onEvent: (e) => console.log(JSON.stringify(e)),
});
app.use(gateway);                                        // your existing Express app
```

## Rules the gateway enforces

- **Exact price.** A claim is accepted only if its price equals the route's price. A claim carrying a lower price is ignored and the buyer is charged the real price.
- **The campaign decides who may sign.** The attribution key must be the one stored on the campaign on-chain, never one named inside the claim.
- **Payer = buyer.** After the facilitator verifies the payment, the paying wallet must equal the claim's buyer; otherwise the request is aborted before anything settles.
- **Fails open for buyers.** If opening the sale fails, or takes longer than 20 seconds, the buyer can still buy: you are paid in full and the referral is lost.
- **One answer per claim.** The payee the gateway names the first time it sees a claim stands until the claim expires, so the payment a buyer signs for it is never refused because a retry got a different answer.
- **A failed resource is not charged.** If your handler answers with an error status, nothing is settled.

## Letting people buy from a browser

Noux's buy page pays your route from the visitor's browser. For that your server must answer cross-origin requests: allow the request headers `content-type`, `payment-signature`, `x-payment`, `access-control-expose-headers` and `x-noux-claim`, and expose `payment-required` and `payment-response`. The sample merchant (`apps/demo-merchant/src/app.ts`) shows the exact headers. Without them, browsers block the payment and only API clients can buy.

## Claim rejection reasons

`missing`, `too_large`, `malformed`, `tampered`, `wrong_program`, `wrong_cluster`, `wrong_campaign`, `wrong_attribution_key`, `price_mismatch`, `expiring` (less than 2 minutes of life left), `self_referral`, `campaign_not_active` (the campaign is paused or ended: no sale is opened and the buyer is charged as a plain purchase). Each one results in a plain purchase and is reported through `onEvent`.

> **Warning** Price and payer checks happen in the gateway, not on-chain. If you serve a paid route without the gateway, those protections do not apply. Attribution and the split still follow the on-chain terms.
