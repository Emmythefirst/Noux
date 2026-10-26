import { serve } from "@hono/node-server";
import { Connection, PublicKey } from "@solana/web3.js";
import { OnchainCampaignReader } from "@axia/core";
import { loadConfig } from "./config";
import { loadSigner } from "./keys";
import { createPool, migrate } from "./db";
import { createApp } from "./app";

const cfg = loadConfig();
const signer = loadSigner(cfg);
const pool = createPool(cfg.DATABASE_URL);
await migrate(pool);
const programId = new PublicKey(cfg.PROGRAM_ID);
const campaigns = new OnchainCampaignReader(new Connection(cfg.RPC_URL, "confirmed"), programId);
const app = createApp({ cfg, pool, signer, campaigns }, { trustProxy: cfg.TRUST_PROXY === "1" });
serve({ fetch: app.fetch, port: cfg.PORT });
console.log(`api listening on :${cfg.PORT} cluster=${cfg.CLUSTER} attributionKey=${signer.publicKey.toBase58()}`);
