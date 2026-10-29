# Moving the claim-signing key into a cloud KMS: evaluation

Date: 2026-10-29. Status: **PARKED until before any mainnet launch** (decided 2026-10-29: Google required a prepayment, and a KMS is not needed while everything runs on devnet; the research, the Google and AWS backends of the test script, and its passing dry runs are ready to pick up). **Researched, not built.** Findings come from provider documentation and package pages reached through web search (I could read search results, not whole pages), plus a ready-to-run spike. **Nothing here has been tested against a real cloud account yet.**

## The question

Today the attribution key (the key whose signature on a claim the program honours) is a file or an environment variable on the host. A KMS would keep it where it can sign but never be read. For Noux this only works if the provider can produce a **standard Ed25519 signature (RFC 8032, "pure" Ed25519) over our raw 197-byte claim message**, because that is exactly what Solana's ed25519 precompile verifies. A provider that only offers a prehashed variant (Ed25519ph) or only ECDSA is useless to us.

## What each provider offers

| Provider | Ed25519? | Pure Ed25519 over a raw message? | Notes |
|---|---|---|---|
| **AWS KMS** | Yes. Announced 7 Nov 2025, available in all regions. Key spec `ECC_NIST_EDWARDS25519`, key usage `SIGN_VERIFY`. | Yes. `ED25519_SHA_512` with message type `RAW` is the pure variant; `ED25519_PH_SHA_512` (message type `DIGEST`) is the prehashed one and must NOT be used. | `Sign` accepts messages of 0 to 4096 bytes (ours is 197). Price: $1 per key per month plus $0.15 per 10,000 requests; asymmetric operations are excluded from the free tier. An open-source Solana signer for it exists (`@solana/keychain-aws-kms`). |
| **Google Cloud KMS** | Yes. `EC_SIGN_ED25519`, purpose `ASYMMETRIC_SIGN`. | Yes. Documented as PureEdDSA ("signs raw message data rather than a hash"). | Price reads as roughly $0.03 per 10,000 operations, but I could not match the figure to a protection level (software vs HSM) from what I could read. |
| **Azure Key Vault / Managed HSM** | **Could not confirm.** | Unknown. | A user report describes Ed25519 persistent keys failing on Azure Cloud HSM (a different product). Do not plan on it without direct confirmation from Microsoft documentation. |
| **HashiCorp Vault (Transit)** | Yes, an `ed25519` key type exists. | **Unknown** from what I could read (pure vs prehashed). | Means running and securing a Vault server ourselves. Not a fit for this stack. |
| **AWS CloudHSM** | Yes (PureEdDSA in some modes). | Yes in those modes. | A dedicated HSM cluster: far heavier and more expensive than needed. |

## Recommendation

**AWS KMS first**, with Google Cloud KMS as an equivalent alternative if you would rather use Google. Both document pure Ed25519, both cost a few dollars a month at our volume, and both fit the existing `ClaimSigner` interface (a public key plus an async `sign(message)`), so no caller changes. Note the project has no cloud account today: the host is Render, the site is on Vercel, and nothing uses AWS or Google.

## What a KMS buys, and what it does not

**Buys**
- The key can no longer leak from a file, an environment variable, a log, a backup or a screenshot. It cannot be extracted at all.
- Every signature is an audited cloud API call.
- **A credential leak is fixed by revoking the credential, with no merchant action.** The public key never changes, so no campaign has to be re-pointed. This is the one case the key-overlap rotation (docs/deploy.md) cannot solve: after a leak of a file key, every campaign stays exposed until its own merchant rotates.

**Does not buy**
- Whoever steals the cloud *credentials* can still ask for signatures until they are revoked. Mitigate with a dedicated identity allowed only `kms:Sign` and `kms:GetPublicKey` on that one key, alerts on unusual signing volume, and instant revocation. I have not verified whether Render supports short-lived workload identity to AWS; without it, a long-lived access key would sit in Render's environment, which moves the secret rather than removing it.
- It makes claim issuance depend on the cloud API. If the KMS is unreachable no claims can be signed. Buyers can still buy without a referral (the buy page offers the plain purchase), and a gateway never blocks a sale on this, so it degrades to "no referrals" rather than "no sales".
- An existing file key cannot be moved in. Treat the KMS key as a new key and migrate with the overlap that is already built: KMS key active, old file key retiring, merchants see a banner and switch.

## The decisive test (ready to run)

`apps/api/scripts/kms-spike.ts` checks, against a real KMS key: the key spec and algorithms, that the public key parses to a Solana address, that a signature over a real claim message verifies as standard Ed25519 using Node's own OpenSSL (an implementation independent of ours), that signing is deterministic, signing latency, and finally **that a claim signed by the KMS key opens a sale on devnet**, i.e. Solana's own verification accepts it, with a control that a claim carrying the same public key but another key's signature is rejected.

A dry run with a local key standing in for the KMS passes 9/9 (this proves the script and that a standard Ed25519 signature from an independent implementation is accepted on-chain; it does not prove any cloud provider).

To run it on AWS:
1. Create the key: `aws kms create-key --key-spec ECC_NIST_EDWARDS25519 --key-usage SIGN_VERIFY --description "noux claim signing (spike)"`
2. Create an identity allowed only `kms:Sign` and `kms:GetPublicKey` on that key's ARN.
3. `cd apps/api && pnpm add -D @aws-sdk/client-kms`, then `AWS_REGION=... AWS_KMS_KEY_ID=... pnpm tsx scripts/kms-spike.ts`.

## Decision: Google Cloud KMS (2026-10-29)

Chosen because it is the cheaper of the two to run (a software-protected key costs about $0.06 a month plus $0.03 per 10,000 signatures; new accounts get a $300 credit for 90 days) and it documents pure Ed25519 (`EC_SIGN_ED25519`). Software protection still means the key cannot be read out; it is a lower tamper-resistance grade than a hardware module (the HSM level costs about $1 a month). The spike script supports both providers (`KMS_PROVIDER=gcp`), and its dry run for each passes.

To run it on Google:
1. Create a Google Cloud account and a project; enable the **Cloud Key Management Service (KMS) API** (billing must be linked).
2. Key ring in **europe-west3 (Frankfurt)**, then a key with purpose **Asymmetric sign**, protection level **Software**, algorithm **Ed25519** (API name `EC_SIGN_ED25519`; I could not confirm the console's exact label). Copy the full key *version* name: `projects/<P>/locations/europe-west3/keyRings/<R>/cryptoKeys/<K>/cryptoKeyVersions/1` (not a secret).
3. A service account with no project roles, granted **Cloud KMS CryptoKey Signer/Verifier** (`roles/cloudkms.signerVerifier`: can sign, verify and read the public key; cannot manage or destroy keys) on that one key only. Narrower roles (`signer`, `publicKeyViewer`) exist but I could not confirm their exact permissions.
4. A JSON key for that service account, kept outside the repository (`chmod 600`), never pasted anywhere.
5. `cd apps/api && pnpm add -D @google-cloud/kms`, then `GOOGLE_APPLICATION_CREDENTIALS=<file> KMS_PROVIDER=gcp GCP_KMS_KEY_VERSION=<name> pnpm tsx scripts/kms-spike.ts`.

A service-account JSON key is itself a long-lived secret, the Google equivalent of an AWS access key. It protects the signing key from being read out, not from being used while the JSON file is in someone's hands; revoke it in IAM if it leaks.

## What building it would involve (about half a day once the spike passes)

An `AwsKmsSigner` implementing `ClaimSigner` (fetch the public key once, parse its DER wrapper, sign with `ED25519_SHA_512` and message type `RAW`, re-verify every signature locally so a misconfigured key can never ship a claim the program would reject), a config option for the key id, a startup self-test, and tests with a fake KMS client. The shape is already proven in the spike.

## What I could not confirm

- Any of the above against a real account: nothing has been signed by a real KMS yet.
- Azure Ed25519 support, and whether Vault's Ed25519 is pure.
- Google's price per protection level, and AWS's requests-per-second quota for Ed25519 (default quotas are normally far above our volume).
- Whether Render can federate to AWS without long-lived keys.

## Sources

- [AWS KMS now supports EdDSA (announcement, German page)](https://aws.amazon.com/de/about-aws/whats-new/2025/11/aws-kms-edwards-curve-digital-signature-algorithm/)
- [AWS KMS Sign API](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html) and [CLI reference](https://docs.aws.amazon.com/cli/latest/reference/kms/sign.html)
- [AWS KMS pricing](https://aws.amazon.com/kms/pricing/)
- [`@solana/keychain-aws-kms` README](https://cdn.jsdelivr.net/npm/@solana/keychain-aws-kms@1.4.0/README.md)
- [Google Cloud KMS algorithms](https://docs.cloud.google.com/kms/docs/algorithms?hl=en) and [pricing](https://cloud.google.com/kms/pricing)
- [HashiCorp Vault Transit API](https://developer.hashicorp.com/vault/api-docs/v1.12.x/secret/transit)
- [Azure Cloud HSM Ed25519 question](https://learn.microsoft.com/en-us/answers/questions/5818206/azure-cloud-hsm-ed25519-(nid-ed25519)-token-key-ge)
