A campaign is the on-chain record of your terms. Create one from **My campaigns → Create campaign** in the merchant console; your wallet approves one transaction and one listing message.

## The terms

| Term | Range | Notes |
|---|---|---|
| Commission | 1% to 50% | Paid to the distributor named in the claim. |
| Commission budget | any amount | A **cap**, not money held by Noux. See below. |
| Refund hold | 0 to 600 seconds | How long you have to refund a failed call before anyone else can settle. |
| Protocol fee | set by the program, max 5% | Copied from the global config when the campaign is created. You cannot change it or redirect it. |
| Cluster | devnet today | Part of every claim, so claims cannot cross clusters. |

Terms are written on-chain when the campaign is created. There is no edit instruction yet, so choose carefully.

## The budget is a cap

The commission budget limits how much commission the campaign can ever pay. Nothing is locked: each sale pays its commission out of that sale's own payment. When the cap is reached, buyers still pay, you keep the rest of every sale, and you simply stop paying commission. If a sale is only partly covered by what is left, the receipt says "budget cap reduced commission".

**Adding budget.** The merchant can raise the cap at any time (**Add budget** on the Budget page or the campaign page). It can only go up: lowering a cap would shrink the commission of sales already in flight, so there is deliberately no way to do it. Adding budget moves no funds. A campaign that ran out of budget starts paying commission again as soon as it is topped up.

The merchant console's **Budget** page shows, per campaign, the cap, what has been paid out, what is left and an estimate of how many more sales it covers.

## Pausing and ending

- **Pause promotions** stops NEW referral sales on the campaign right away, enforced by the program itself (not only by the gateway): `open_sale` refuses unless the campaign is active. Buyers can still buy from you without a referral and you are paid in full. Sales that were already open settle normally and can still be refunded. **Resume promotions** reopens referral sales at once. The first pause creates a small on-chain record (under 0.002 SOL, paid by your wallet); campaigns that were never paused have none.
- **End campaign** is permanent. The campaign takes no new referral sales and can never be resumed or paused again. Open sales still settle, past receipts stay public and verifiable (the campaign account is never deleted, because receipt verification reads it), and you can still raise the budget or change the claim key. To promote the service again, create a new campaign. Ended campaigns leave the public directory.
- While a campaign is paused or ended the claim service answers a claim request with `409 campaign_not_active` and a gateway treats a referred request as a plain purchase.
- The gateway and claim service learn the state within about 15 seconds; the program enforces it immediately.

## The claim key

Every referral claim for a campaign is signed by one key, and the program only accepts claims signed by the key stored on the campaign. A merchant can change that key at any time (**Change claim key** on the campaign page), for example if the key may have leaked or to move to a new Noux claim key. It takes effect immediately: claims signed by the old key stop working (buyers simply request a new one), and sales that were already open settle normally. Only the merchant wallet can change it. Choose a key whose owner you trust: if nobody holds the private key, no referral claim can be issued for the campaign, although buyers can still buy without a referral.

## Listing

A campaign exists on-chain without a listing; the **listing** is the name, description, category, endpoint URL, route and price you sign with your wallet so people can find it. Only listed campaigns appear in the public directory.

- **List this campaign / Edit listing** on the campaign page (visible to the campaign's own merchant wallet).
- **Remove from directory** hides it again; the campaign itself stays on-chain and keeps working for anyone with the link.
- An **unlisted** campaign is a private campaign. The page tells visitors that its merchant has not published a listing and to promote it only if they trust the merchant.

## Legacy campaigns

Campaigns created before the protocol fee was enforced have a fee chosen by their creator and are marked "legacy". New campaigns always use the program's fee.
