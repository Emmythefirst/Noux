## `POST /v1/claims`

Issues a signed, buyer-bound claim. Open to anyone with a buyer wallet; rate-limited.

**Request body** (all fields required, no extra fields):

| Field | Type | Meaning |
|---|---|---|
| `campaign` | string | Campaign address. Must name this service's attribution key and cluster. |
| `distributor` | string | The referrer's wallet. Cannot equal the buyer. |
| `buyer` | string | The buyer's wallet. |
| `price` | string | Integer, base units of the campaign mint (6 decimals: `100000` = 0.10 USDC). At most the service's maximum price. |
| `ts` | integer | Unix seconds. Must be within 60 seconds of the server's time. |
| `buyerSignature` | string | Base64 ed25519 signature by the buyer over `NOUX-CLAIM-REQ-v1\|campaign\|distributor\|buyer\|price\|ts`. |

**Response** `201 { "claim": ClaimWire }`:

| Field | Meaning |
|---|---|
| `programId`, `cluster`, `campaign`, `distributor`, `buyer` | What the claim is bound to. |
| `expiry` | Unix seconds. The claim is valid for 10 minutes. |
| `price` | The bound price (base units). |
| `nonce` | 32 bytes, hex. Chosen by the server; the sale account address derives from it. |
| `attributionKey` | The key that signed. The campaign must trust it. |
| `message`, `signature` | The signed 197-byte message and the signature (base64). |

Send it in the `x-noux-claim` header as base64 of this JSON.

**Errors** `{ "error": { "code", "message" } }`:

| Status | `code` | When |
|---|---|---|
| 400 | `bad_request` | Malformed body, key, price or timestamp. |
| 400 | `bad_price` | Price is zero or above the maximum. |
| 400 | `self_referral` | `distributor` equals `buyer`. |
| 409 | `campaign_not_active` | The campaign is paused or ended and takes no new referral sales. |
| 401 | `bad_buyer_signature` | Not signed by the buyer, altered after signing, or older than 60 seconds. |
| 404 | `campaign_not_found` | No such campaign, a different cluster, or it trusts a different attribution key. |
| 429 | `rate_limited` | Too many claims for this distributor, buyer, campaign or IP in the last minute. `Retry-After` is set. |
| 503 | `internal` | Something failed on our side. |

Default limits per minute: 30 per distributor, 10 per buyer, 120 per campaign, 60 per IP.

## `GET /v1/claim-service`

Public information a campaign needs: `attributionKey` (the key a new campaign must name so this service can issue claims for it), `retiringKeys` (keys the service is phasing out: it still signs for campaigns that trust them, and merchants are asked to switch), `campaignsByKey` (how many non-ended campaigns trust each of those keys), `cluster`, `programId` and `claimTtlSecs`.
