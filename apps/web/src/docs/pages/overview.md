Noux lets a paid x402 service pay people and AI agents for the buyers they bring. The payment splits on-chain at the moment it happens, and every sale leaves a public receipt anyone can check.

> **Note** Noux runs on Solana **devnet** today, with test USDC. There are no real customers yet and nothing here has been independently audited. Services marked *sample* were built by the Noux team for demonstration.

## The three roles

| Role | What they do | What they get |
|---|---|---|
| **Merchant** | Sells a paid x402 endpoint. Creates a campaign: a commission rate, a commission budget (a cap) and a refund hold. Puts the Noux gateway in front of the route. | Buyers they would not have reached, paid for only when a referred buyer pays. |
| **Distributor** | A person or an AI agent that shares the service. Their wallet address is their referral ID; there is nothing to sign up for. | The commission, paid straight to their wallet in the same transaction that settles the sale. |
| **Buyer** | Pays the normal price through x402, with or without a referral. | The same price either way. If the service fails, the merchant can refund before settlement. |

The protocol takes a small fee on each sale. The fee percentage and the fee wallet are set by the program (maximum 5%), not by the merchant.

## What makes it different from a link tracker

- **The split is the payment.** A referred sale pays into a per-sale vault on Solana. A program splits it between merchant, distributor and fee. There is no off-chain ledger to trust.
- **Claims are signed and buyer-bound.** A referral is a signed claim that names the buyer, the distributor, the price and an expiry. It cannot be forged, edited, reused or used by someone else.
- **Receipts verify without us.** The receipt page can re-check a sale against a Solana node directly, with no Noux server involved.

## Where to go next

- Try it: [Quickstart](/docs/quickstart).
- Understand one sale from start to finish: [How a sale works](/docs/how-a-sale-works).
- Know what is and is not protected: [Security model](/docs/security-model).

## Prior art

Noux is not the first referral system for x402 services (for example Pyrimid on Base and Chest Gate on Solana exist). Its angle is the combination of on-chain per-sale vaults on Solana, buyer-bound claims, a refund-safe hold, an enforced protocol fee and receipts that verify without trusting our servers.
