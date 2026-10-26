# Deploying on Render

Two ways. Both build the repo-root `Dockerfile`.

## A. Blueprint (one step, recommended)
Dashboard -> **New** -> **Blueprint** -> pick the GitHub repo. Render reads `render.yaml`, creates the web service and a
Postgres database, and asks you once for the three secrets (`RPC_URL`, `ATTRIBUTION_KEY_B58`, `KEEPER_PAYER_B58`).

## B. By hand (what the screen offers)
| Card on "Create a new Service" | Use it for |
|---|---|
| **Web Services** | the API (public URL, `/healthz`) - required |
| **Postgres** | the database - required |
| **Background Workers** | only if you run the keeper as its own service (not needed: it can run inside the API) |
| Static Sites | the UI later (or host the UI on Vercel) |
| Private Services, Cron Jobs, Key Value, Workflow | not needed |

Web Service settings: Language **Docker**, Dockerfile Path `./Dockerfile`, Health Check Path `/healthz`, Region Frankfurt
(same region as the database so the internal connection string works), plan **paid, always-on**.

## Environment variables
| Variable | Value |
|---|---|
| `DATABASE_URL` | the database's **Internal** connection string |
| `RPC_URL` | your Helius/other RPC URL for the cluster |
| `PROGRAM_ID` | `AC6AtoRALLszNGNLmHte2UXKzCqBYQKhPdtq5qs77nkL` (devnet) |
| `CLUSTER` | `devnet` (<= 8 chars; must equal the cluster tag in the campaigns) |
| `ATTRIBUTION_KEY_B58` | claim-signing secret key (base58). Fresh per cluster |
| `TRUST_PROXY` | `1` (Render sits in front: use X-Forwarded-For for rate-limit IPs) |
| `MINT` + `KEEPER_PAYER_B58` | set BOTH to run the settlement keeper inside the API process |
| optional | `CLAIM_TTL_SECS`, `MAX_PRICE_BASE_UNITS`, `LIMIT_PER_*_PER_MIN`, `KEEPER_TICK_SECONDS` |

Render turns env vars into Docker build args too; the Dockerfile never references any of them, so no secret enters an image layer.

## Costs and limits (from Render's docs; verify current prices yourself)
- Free web services **spin down after 15 min idle and take ~1 min to wake**: do not use the free plan for the gateway/API.
- Free Postgres: 1 GB, **expires 30 days after creation** (+14-day grace), no backups. Fine through the hackathon; upgrade or recreate after.
- Background workers have **no free tier**: another reason to embed the keeper.

## Key hygiene
- A fresh attribution key per cluster. The devnet test keys in `spike/keys/` must never be used on mainnet.
- The keeper payer only pays fees/rent and can settle only after the hold; it cannot refund. Keep a small SOL float.
- A KMS/HSM signer can replace `LocalKeySigner` (the `ClaimSigner` interface) without touching callers.

## Verified locally
`docker build -t noux-api:local .` and run with the env above: `/healthz` answers and the process runs as user `node`.
