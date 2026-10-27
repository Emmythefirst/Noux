import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { OnchainCampaignReader } from "@noux/core";
import { AnchorChain } from "@noux/gateway";
import { loadConfig } from "./config";
import { createDemoApp } from "./app";

const cfg = loadConfig();
const conn = new Connection(cfg.RPC_URL, "confirmed");
const programId = new PublicKey(cfg.PROGRAM_ID), mint = new PublicKey(cfg.MINT);
const payer = Keypair.fromSecretKey(bs58.decode(cfg.GATEWAY_PAYER_B58));
const merchant = cfg.MERCHANT_SIGNER_B58 ? Keypair.fromSecretKey(bs58.decode(cfg.MERCHANT_SIGNER_B58)) : undefined;
const facilitator = new HTTPFacilitatorClient(cfg.FACILITATOR === "cdp" ? createFacilitatorConfig(cfg.CDP_API_KEY_ID, cfg.CDP_API_KEY_SECRET) : { url: "https://x402.org/facilitator" });
const chain = new AnchorChain({ connection: conn, programId, mint, gatewayPayer: payer, merchant });

const { app } = createDemoApp({
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
