## When things go wrong

A payment system is judged by what happens when something fails. This page lists every failure path we handle, what the buyer, the distributor and the merchant end up with, and where it was checked. The first three were run on real Solana devnet with real x402 payments through the Coinbase CDP facilitator; the script is `apps/api/scripts/failure-paths-devnet.ts` in the repository, and every result below links to its transactions.

## 1. A replayed claim

A claim is a one-time permission for one buyer to make one purchase. The program makes the sale account a PDA of the campaign and the claim's nonce, so a claim can open exactly one sale.

| Attempt | Result |
|---|---|
| Use the same claim again through the gateway | **Refused with HTTP 402.** The first sale is already settled and its vault is closed, so the second payment is not accepted. The buyer is charged nothing and nobody earns a second commission. |
| Send `open_sale` for the same claim straight to the program | **Fails.** The sale account already exists. |

Checked on devnet: the first use split 0.084 / 0.015 / 0.001 USDC (merchant, distributor, protocol); the replay moved no money at all.

## 2. A refund inside the hold

Every sale has a hold. Until it ends only the merchant can settle, and until the sale settles the merchant can refund.

| Step | Result |
|---|---|
| The buyer pays through the gateway | The 0.10 USDC lands in the **per-sale vault**, not in anyone's wallet. The sale is open. |
| The merchant refunds inside the hold | The **whole** 0.10 USDC returns to the buyer. The distributor and the protocol receive nothing. The sale stays as a public **Refunded** receipt. |
| Anyone tries to settle it afterwards | **Fails.** A refunded sale can no longer settle. |

A refund is the merchant's choice, not an automatic guarantee. Refund counts and rates are public per campaign and per merchant.

## 3. An exhausted commission budget

The commission budget is a cap. When it runs out, buyers still pay and are still served; the merchant just stops paying commission. Checked on devnet with a 0.01 USDC budget and a 15% commission on a 0.10 USDC sale (0.015 owed):

| Sale | Merchant | Distributor | Protocol | Buyer |
|---|---|---|---|---|
| 1. Budget covers only part of the commission | +0.089 | **+0.010** (capped at the remaining budget) | +0.001 | pays 0.10, served |
| 2. Budget now empty | +0.099 | **+0** | +0.001 | pays 0.10, **served** |

The campaign then shows **Budget spent**. The merchant can top the budget up at any time (it can raise a budget, never lower it).

## Every other failure path

| What goes wrong | What happens | Who stops it |
|---|---|---|
| A claim is forged or edited | Rejected. No referral is credited. | The ed25519 signature check, in the gateway and again in the program |
| A claim is expired | Rejected. | The program and the gateway |
| The distributor refers themselves | Rejected. | The claim API and the program |
| A different wallet pays someone else's claim | Refused before any money moves. | The gateway's payer-binding check |
| A claim carries a lower price than the route | The gateway charges the real price. No discount, no commission on the difference. | The gateway's exact-price rule |
| No claim at all | A plain purchase: the merchant is paid in full, no sale vault. | The gateway |
| The campaign is paused or ended | New referral sales are refused by the program; the gateway answers with a plain purchase at once. Sales already open still settle and can still be refunded. | `open_sale` and the gateway |
| The vault holds less than the claim price | The program refuses to settle it (`Underpaid`); the merchant can refund it. | `settle_sale` |
| The facilitator times out and the result is unknown | The gateway asks the chain whether the payment landed before it retries, and never signs a payment twice. An unresolved case is reported as pending, never as success. | The resilient facilitator client |
| The gateway cannot open a sale in time (20 s) | It **fails open**: the buyer still buys, the merchant is paid in full, the referral is lost. No money is stolen. | The gateway |
| The merchant never settles | The keeper settles any funded sale after the hold, and closes expired unfunded sales so their rent comes back. | The keeper |
| A claim-service key leaks | Merchants rotate the key their campaign trusts, on-chain, at once; the service signs with the key each campaign trusts during the overlap. | `set_attribution_key` |

> **Note** The replay, refund and budget results above come from one real devnet run, not from a mock. Rerun them yourself: `pnpm tsx apps/api/scripts/failure-paths-devnet.ts` needs a funded devnet wallet and Coinbase CDP credentials.

## Evidence

Run on 2026-11-06 against the live devnet program. Each link opens the transaction on Solana Explorer.

- campaign (replay + refund): [5Jvs…f4KP](https://explorer.solana.com/address/5Jvs57smXmvbQ1b3etiGrM3sZR4B8qXh3xDorGGhf4KP?cluster=devnet)
- replay, first use x402 payment: [view transaction](https://explorer.solana.com/tx/3Ar9C3yUsL7bRvmGWfcbi2CMQKV4DUPjUAnV9iD7a4rTkGGRGH7HXtcMGk3F4zr2uoKMocRB6quRLVTAnVgYgheY?cluster=devnet)
- replay: second use x402 payment (the payment was refused, so there is no transaction)
- campaign (refund): [H1Lg…ht4n](https://explorer.solana.com/address/H1LgroavDrL4kUfvSYULofUsvPSrtAm8hUiVgoaGht4n?cluster=devnet)
- refund, x402 payment into the vault: [view transaction](https://explorer.solana.com/tx/5nb58GKiSM3q88ckApBEka7ypnLUHozJnQkphfCeRqtv4w7jmj8jTdqP1Bm6DwHqRz2eLxJMSmcFJkaBArzWfo2w?cluster=devnet)
- refund, refund_sale: [view transaction](https://explorer.solana.com/tx/4kkPyMWoaSMsmioGiPkAmRHP1oEEGoKM8zRZbWgXBqULiKsYj37UaAU3XxkQAvn3ghG2SesQJdekf4YZ2KY3Ed2o?cluster=devnet)
- campaign (budget): [BPSu…7YmW](https://explorer.solana.com/address/BPSuUZTTH8p5kQbjxNfk25FiJ7523qBQZxorJj1j7YmW?cluster=devnet)
- budget, sale 1 x402 payment: [view transaction](https://explorer.solana.com/tx/3oUengLGioJfMCGaCgSCBu4JQrfEJeKhzgsUnEfC2sLRpjSHu72c9Pssu7GrFFET8LyygfehYpyno8hkVHjT8BS6?cluster=devnet)
- budget, sale 2 x402 payment: [view transaction](https://explorer.solana.com/tx/3uRDrxKmMjrpSPwnti8dCGtdBic3pXshFMwkn6Vx7nfF9W4hZ8jYmzJqyALoMUAqY5LWWFCzygDRfrnx66vSsyyq?cluster=devnet)
