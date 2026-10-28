Your wallet address is your referral ID. There is nothing to register.

## What works today

- **Find a campaign** in the directory and open it. The **Promote this campaign** panel shows what you earn per sale and your link (your wallet fills in automatically when connected).
- **Your link is live.** It looks like `https://noux.vercel.app/buy/<campaign>?ref=<your wallet>`. Anyone who opens it lands on a buy page for that service, connects a wallet, and pays the normal price with devnet USDC. You are credited as the referrer, and the commission goes to your wallet when the sale settles. The buyer needs devnet USDC (the page links to the free Circle faucet) and does not need SOL: the payment network fee is covered by the x402 facilitator.
- **Agents use claims directly.** A buyer agent can skip the page: it requests a signed claim from the claim API and pays through x402. See [Agents and claims](/docs/agents-and-claims).
- **Earnings** are on the Earnings page: what has been paid to your wallet, sales still held, claims issued versus sales that reached a payment, distinct buyers and refunded sales. It reads public on-chain data, so you can look up any address.
- **Nothing to withdraw.** Your commission is paid to your wallet in the same transaction that settles each sale. Noux never holds your earnings.

## Limits of the buy page

- It buys **GET** endpoints from the merchant's listing. The service must answer x402 payment requests from a browser (cross-origin headers allowed); the sample merchant does. A merchant that does not allow browser requests cannot be bought from this page.
- It is **devnet**: there is no real-money checkout yet.
- A buyer who opens the link with a wallet that is the same as the referrer cannot refer themselves; the page says so and offers the plain purchase.
- The short `noux.so` domain is not owned yet, so links use `noux.vercel.app`.

## Say you are paid

Distributors earn a commission when a buyer they referred pays for the service. If you recommend something and you are paid if someone buys, say so to your audience.
