import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { OnchainCampaignReader } from "@noux/core";
import { AnchorChain } from "@noux/gateway";
import { loadConfig } from "./config";
import { createDemoApp, scrub } from "./app";

const cfg = loadConfig();
const conn = new Connection(cfg.RPC_URL, "confirmed");
const programId = new PublicKey(cfg.PROGRAM_ID), mint = new PublicKey(cfg.MINT);
const payer = Keypair.fromSecretKey(bs58.decode(cfg.GATEWAY_PAYER_B58));
const merchant = cfg.MERCHANT_SIGNER_B58 ? Keypair.fromSecretKey(bs58.decode(cfg.MERCHANT_SIGNER_B58)) : undefined;
const facilitator = new HTTPFacilitatorClient(cfg.FACILITATOR === "cdp" ? createFacilitatorConfig(cfg.CDP_API_KEY_ID, cfg.CDP_API_KEY_SECRET) : { url: "https://x402.org/facilitator" });
const chain = new AnchorChain({ connection: conn, programId, mint, gatewayPayer: payer, merchant });

const secrets = [cfg.CDP_API_KEY_SECRET, cfg.CDP_API_KEY_ID, cfg.GATEWAY_PAYER_B58, cfg.MERCHANT_SIGNER_B58, new URL(cfg.RPC_URL).searchParams.get("api-key")].filter(Boolean) as string[];
const step = async (f: () => Promise<Record<string, unknown>>) => { try { return { ok: true, ...(await f()) }; } catch (e) { return { ok: false, error: scrub((e as Error).message, secrets) }; } };
const campaignKey = new PublicKey(cfg.CAMPAIGN), reader = new OnchainCampaignReader(conn, programId, 0, 0);
async function diagnose() {
  const sec = cfg.CDP_API_KEY_SECRET ?? "", kid = cfg.CDP_API_KEY_ID ?? "";
  const rpcUrl = new URL(cfg.RPC_URL);
  return {
    cluster: cfg.CLUSTER, facilitatorMode: cfg.FACILITATOR, settleAfterDelivery: !!merchant,
    // shapes only, never values: lets an operator spot a mangled credential (wrong length, lost trailing '=') without logs
    credentialShape: { rpcHost: rpcUrl.host, rpcHasApiKeyParam: rpcUrl.searchParams.has("api-key"), cdpIdLength: kid.length, cdpSecretLength: sec.length, cdpSecretTrailingEquals: sec.length - sec.replace(/=+$/, "").length, cdpIdFingerprint: createHash("sha256").update(kid).digest("hex").slice(0, 8), cdpSecretFingerprint: createHash("sha256").update(sec).digest("hex").slice(0, 8) /* truncated one-way hash: compare with the local value, reveals nothing usable */, cdpSecretOddChars: (sec.match(/[^A-Za-z0-9+/=]/g) ?? []).length, cdpSecretDecodedBytes: Buffer.from(sec, "base64").length /* an Ed25519 CDP secret decodes to 64 */, payerKeyLength: cfg.GATEWAY_PAYER_B58.length },
    rpc: await step(async () => ({ slot: await conn.getSlot("confirmed") })),
    payer: await step(async () => { const l = await conn.getBalance(payer.publicKey); return { address: payer.publicKey.toBase58(), sol: l / 1e9, low: l < 20_000_000 }; }),
    campaign: await step(async () => { const c = await reader.get(campaignKey); if (!c) throw new Error("campaign account not found / not owned by the program"); return { found: true, cluster: c.cluster, merchantMatchesPayTo: c.merchant.toBase58() === cfg.MERCHANT_PAYTO, merchantSignerMatches: merchant ? merchant.publicKey.equals(c.merchant) : null, holdSecs: c.holdSecs }; }),
    facilitator: await step(async () => { const s = await facilitator.getSupported(); const k = s.kinds.filter((x: any) => x.network === cfg.NETWORK && x.scheme === "exact"); return { supportsNetwork: k.length > 0, kinds: s.kinds.length }; }),
  };
}

const { app } = createDemoApp({
  diagnose,
  cluster: cfg.CLUSTER, network: cfg.NETWORK, claimsApiUrl: cfg.CLAIMS_API_URL, publicUrl: cfg.PUBLIC_URL,
  campaign: new PublicKey(cfg.CAMPAIGN), mint, merchantPayTo: new PublicKey(cfg.MERCHANT_PAYTO),
  gateway: {
    programId, cluster: cfg.CLUSTER, campaign: new PublicKey(cfg.CAMPAIGN), mint, network: cfg.NETWORK, merchantPayTo: new PublicKey(cfg.MERCHANT_PAYTO),
    facilitator, connection: conn, campaigns: new OnchainCampaignReader(conn, programId), opener: chain, settler: merchant ? chain : undefined,
    // one JSON line per event; events carry public keys and reasons only, never keys or payloads
    onEvent: (e) => { if (e.type !== "facilitator") console.log(JSON.stringify({ t: new Date().toISOString(), ...e })); },
  },
});
app.listen(cfg.PORT, () => console.log(`demo merchant on :${cfg.PORT} cluster=${cfg.CLUSTER} campaign=${cfg.CAMPAIGN} payer=${payer.publicKey.toBase58()} settleAfterDelivery=${!!merchant} facilitator=${cfg.FACILITATOR}`));
