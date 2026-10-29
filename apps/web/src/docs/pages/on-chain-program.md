## Accounts

All four are Anchor accounts owned by the program.

| Account | Address (PDA seeds) | Fields |
|---|---|---|
| **Config** | `["config"]` | `admin`, `fee_owner`, `fee_bps`, `bump`. One per program. |
| **Campaign** | `["campaign", merchant, campaign_id]` | `merchant`, `mint`, `fee_owner`, `attribution_key`, `cluster` (8 bytes), `hold_secs`, `settled_count`, `refunded_count`, `campaign_id`, `commission_budget`, `commission_spent`, `commission_bps`, `fee_bps`, `bump`. |
| **CampaignControl** | `["control", campaign]` | `campaign`, `state` (`Active`, `Paused`, `Ended`), `bump`. Created the first time a merchant pauses or ends; a campaign with no control account is active. |
| **Sale** | `["sale", campaign, nonce]` | `campaign`, `distributor`, `buyer`, `rent_payer`, `nonce`, `expiry`, `opened_at`, `hold_until`, `settled_at`, `price`, `gross`, `merchant_amount`, `commission_amount`, `fee_amount`, `commission_bps`, `fee_bps`, `status`, `bump`. Its vault is the associated token account of the sale PDA. |

A **Sale** doubles as the public receipt: after settlement it keeps the final amounts, and `status` is `Open`, `Settled` or `Refunded`. `gross` stays 0 until settlement or refund; while a sale is open the amount paid is the balance of its vault.

## Instructions

`init_config`, `update_config`, `create_campaign`, `open_sale`, `settle_sale`, `refund_sale`, `close_expired_sale`, and three merchant-only campaign controls: `top_up_budget` (raise the commission cap; never lower it), `set_attribution_key` (change the key the campaign trusts to sign claims; effective at once) and `set_campaign_state` (pause, resume or permanently end new referral sales; enforced by `open_sale`). Full table in the repository's architecture document.

## Limits

| Constant | Value |
|---|---|
| `MAX_COMMISSION_BPS` | 5000 (50%) |
| `MAX_FEE_BPS` | 500 (5%) |
| `MAX_HOLD_SECS` | 600 |
| Claim message length | 197 bytes |

## Errors

`BpsTooHigh`, `ClaimExpired`, `SelfReferral`, `ZeroPrice`, `BadSignatureIx`, `WrongSigner`, `ClaimMismatch`, `AlreadySettled`, `Underpaid`, `NotExpired`, `VaultNotEmpty`, `HoldActive`, `HoldTooLong`, `NothingToRefund`, `Math`, `NotUpgradeAuthority`, `NotAdmin`, `NotMerchant`, `BadBudgetIncrease`, `InvalidKey`, `CampaignNotActive`, `BadStateChange`.

## Deployments

| Cluster | Program ID |
|---|---|
| Solana devnet | `AC6AtoRALLszNGNLmHte2UXKzCqBYQKhPdtq5qs77nkL` |

The program is upgradeable by a single wallet today (see the [Security model](/docs/security-model)). There is no mainnet deployment yet.
