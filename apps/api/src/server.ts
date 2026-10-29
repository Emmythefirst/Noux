import { serve } from "@hono/node-server";
import { Connection, PublicKey } from "@solana/web3.js";
import { OnchainCampaignReader } from "@noux/core";
import { loadConfig } from "./config";
import { loadRetiringSigners, loadSigner } from "./keys";
import { createPool, migrate } from "./db";
import { createApp } from "./app";
import { startKeeperLoop } from "./keeper-loop";
import { AnchorIndexerChain } from "./indexer/chain";
import { startIndexerLoop } from "./indexer/sync";

const cfg = loadConfig();
const signer = loadSigner(cfg);
const retiringSigners = loadRetiringSigners(cfg, signer);
const pool = createPool(cfg.DATABASE_URL);
await migrate(pool);
const programId = new PublicKey(cfg.PROGRAM_ID);
const campaigns = new OnchainCampaignReader(new Connection(cfg.RPC_URL, "confirmed"), programId);
const app = createApp({ cfg, pool, signer, retiringSigners, campaigns }, { trustProxy: cfg.TRUST_PROXY === "1", proxyHops: cfg.TRUSTED_PROXY_HOPS, public: { pool, campaigns, cluster: cfg.CLUSTER, programId: cfg.PROGRAM_ID, decimals: cfg.MINT_DECIMALS } });
serve({ fetch: app.fetch, port: cfg.PORT });
console.log(`api listening on :${cfg.PORT} cluster=${cfg.CLUSTER} attributionKey=${signer.publicKey.toBase58()}${retiringSigners.length ? ` retiring=${retiringSigners.map((s) => s.publicKey.toBase58()).join(",")}` : ""}`);

if (cfg.KEEPER_PAYER_B58 && cfg.MINT) {
  const stop = startKeeperLoop({ pool, rpcUrl: cfg.RPC_URL, programId: cfg.PROGRAM_ID, mint: cfg.MINT, payerB58: cfg.KEEPER_PAYER_B58, tickSeconds: cfg.KEEPER_TICK_SECONDS });
  for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { stop(); setTimeout(() => process.exit(0), 500); });
} else {
  console.log("embedded keeper disabled (set MINT and KEEPER_PAYER_B58 to enable)");
}

if (cfg.ENABLE_INDEXER === "1") {
  const stop = startIndexerLoop({ pool, chain: new AnchorIndexerChain(new Connection(cfg.RPC_URL, "confirmed"), programId), intervalSeconds: cfg.INDEXER_INTERVAL_SECONDS, forceFull: cfg.INDEXER_MODE === "full" });
  for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => stop());
}
